// Pulse catalog seed — pulls real, freely-licensed albums from the Internet Archive
// (Free Music Archive, netlabels, 78rpm collections), organized by genre, and loads
// artists / albums / tracks into Supabase. Re-running is safe: rows are upserted.
//
// Usage: DATABASE_URL=postgresql://... node supabase/seed/seed.mjs [--limit N]

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i !== -1 ? Number(process.argv[i + 1]) : Infinity;
})();

const CONCURRENCY = 8;
const MAX_TRACKS_PER_ALBUM = 40;

// Genre-driven searches: each query contributes its most-downloaded albums.
const GENRE_QUERIES = [
  { genre: 'Electronic', q: 'collection:(freemusicarchive OR netlabels) AND subject:(electronic)', rows: 90 },
  { genre: 'Ambient', q: 'collection:(freemusicarchive OR netlabels) AND subject:(ambient)', rows: 80 },
  { genre: 'Rock', q: 'collection:(freemusicarchive OR netlabels) AND subject:(rock)', rows: 90 },
  { genre: 'Pop', q: 'collection:(freemusicarchive OR netlabels) AND subject:(pop)', rows: 80 },
  { genre: 'Hip-Hop', q: 'collection:(freemusicarchive OR netlabels) AND subject:(hip-hop)', rows: 80 },
  { genre: 'Jazz', q: 'collection:(freemusicarchive OR netlabels OR 78rpm) AND subject:(jazz)', rows: 90 },
  { genre: 'Classical', q: 'collection:(freemusicarchive OR netlabels OR 78rpm) AND subject:(classical)', rows: 80 },
  { genre: 'Folk', q: 'collection:(freemusicarchive OR netlabels) AND subject:(folk)', rows: 70 },
  { genre: 'Experimental', q: 'collection:(freemusicarchive OR netlabels) AND subject:(experimental)', rows: 70 },
  { genre: 'Punk', q: 'collection:(freemusicarchive OR netlabels) AND subject:(punk)', rows: 60 },
  { genre: 'Metal', q: 'collection:(freemusicarchive OR netlabels) AND subject:(metal)', rows: 60 },
  { genre: 'Techno', q: 'collection:(freemusicarchive OR netlabels) AND subject:(techno)', rows: 60 },
  { genre: 'House', q: 'collection:(freemusicarchive OR netlabels) AND subject:(house)', rows: 60 },
  { genre: 'Dance', q: 'collection:(freemusicarchive OR netlabels) AND subject:(dance)', rows: 50 },
  { genre: 'Lo-Fi', q: 'collection:(freemusicarchive OR netlabels) AND subject:(lo-fi)', rows: 60 },
  { genre: 'Instrumental', q: 'collection:(freemusicarchive OR netlabels) AND subject:(instrumental)', rows: 50 },
  { genre: 'Funk', q: 'collection:(freemusicarchive OR netlabels) AND subject:(funk)', rows: 50 },
  { genre: 'World', q: 'collection:(freemusicarchive OR netlabels) AND subject:(world)', rows: 50 },
  { genre: 'Blues', q: 'collection:(freemusicarchive OR netlabels OR 78rpm) AND subject:(blues)', rows: 60 },
  { genre: 'Reggae', q: 'collection:(freemusicarchive OR netlabels) AND subject:(reggae)', rows: 40 },
  { genre: 'Soul', q: 'collection:(freemusicarchive OR netlabels) AND subject:(soul)', rows: 40 },
  { genre: 'Country', q: 'collection:(freemusicarchive OR netlabels) AND subject:(country)', rows: 40 },
  { genre: 'Spoken', q: 'collection:(freemusicarchive OR netlabels) AND subject:(spoken)', rows: 30 },
];

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
}

async function pMap(items, fn, concurrency = CONCURRENCY) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

function parseTrackFilename(name) {
  let base = name.replace(/\.mp3$/i, '').trim();
  let rest = base;
  const numMatch = base.match(/^\d{1,3}\s*[-.]\s*(.+)$/);
  if (numMatch) rest = numMatch[1].trim();
  const parts = rest.split(/\s+-\s+/);
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return { artist: null, title: rest };
}

function coverUrl(identifier, files) {
  const images = files.filter((f) => /\.(jpe?g|png)$/i.test(f.name) && !/__ia_thumb/.test(f.name));
  if (!images.length) return null;
  images.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
  const preferred = images.find((f) => /itemimage|cover/i.test(f.name)) || images[0];
  return `https://archive.org/download/${identifier}/${encodeURIComponent(preferred.name)}`;
}

function audioUrl(identifier, fileName) {
  return `https://archive.org/download/${identifier}/${encodeURIComponent(fileName)}`;
}

// Returns Map<identifier, { genre, downloads }>
async function collectIdentifiers() {
  const ids = new Map();
  for (const query of GENRE_QUERIES) {
    const params = new URLSearchParams({
      q: `${query.q} AND mediatype:(audio) AND format:(MP3)`,
      fl: 'identifier,downloads',
      rows: String(query.rows),
      sort: 'downloads desc',
      output: 'json',
    });
    const data = await fetchJson(`https://archive.org/advancedsearch.php?${params.toString()}`);
    const docs = data?.response?.docs || [];
    let added = 0;
    for (const d of docs) {
      if (d.identifier && !ids.has(d.identifier)) {
        ids.set(d.identifier, { genre: query.genre, downloads: Number(d.downloads) || 0 });
        added++;
      }
    }
    console.log(`  ${query.genre}: ${docs.length} items (${added} new)`);
  }
  return ids;
}

async function buildAlbum([identifier, meta]) {
  const data = await fetchJson(`https://archive.org/metadata/${identifier}`);
  const item = data.metadata || {};
  const files = data.files || [];
  const mp3s = files
    .filter((f) => /\.mp3$/i.test(f.name) && /mp3/i.test(f.format || ''))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!mp3s.length || mp3s.length > MAX_TRACKS_PER_ALBUM) return null;

  const title = (item.title || identifier).trim();
  const creator = (item.creator || '').toString().trim();
  const genre = meta.genre;
  let albumArtist = creator;
  if (/^v\/a\b/i.test(title) || /^v\/a\b/i.test(creator) || /various artists/i.test(creator)) {
    albumArtist = 'Various Artists';
  }
  const yearRaw = parseInt(item.year, 10);
  const releaseYear = Number.isFinite(yearRaw) ? yearRaw : null;
  const cover = coverUrl(identifier, files);
  const licenseUrl = item.licenseurl || null;
  const trackPlays = (i) => {
    const n = mp3s.length;
    const totalWeight = (n * (n + 1)) / 2;
    return Math.max(1, Math.round((meta.downloads * (n - i)) / totalWeight));
  };

  const tracks = mp3s.map((f, i) => {
    const parsed = parseTrackFilename(f.name);
    const length = Number(f.length);
    return {
      external_id: `${identifier}/${f.name}`,
      title: parsed.title || f.name.replace(/\.mp3$/i, ''),
      artist: parsed.artist || albumArtist || 'Unknown Artist',
      audio_url: audioUrl(identifier, f.name),
      cover_url: cover,
      duration_ms: Number.isFinite(length) ? Math.round(length * 1000) : null,
      track_number: i + 1,
      genre,
      release_year: releaseYear,
      license_url: licenseUrl,
      plays_count: trackPlays(i),
    };
  });

  return {
    external_id: identifier,
    title,
    artist: albumArtist || 'Unknown Artist',
    cover_url: cover,
    release_year: releaseYear,
    genre,
    source: 'archive',
    tracks,
  };
}

// Batched upsert: keeps parameter counts well under Postgres' 65535 limit.
async function upsertInBatches(client, insertSql, onConflictSql, rows, columns, batchSize) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const params = [];
    const tuples = batch.map((row, idx) => {
      const placeholders = row.map((_, j) => `$${idx * columns + j + 1}`);
      params.push(...row);
      return `(${placeholders.join(', ')})`;
    });
    await client.query(`${insertSql} values ${tuples.join(', ')} ${onConflictSql}`, params);
  }
}

async function main() {
  console.log('Pulse catalog seed');
  console.log('Collecting identifiers by genre...');
  const identifierMap = await collectIdentifiers();
  console.log(`Total unique albums: ${identifierMap.size}`);

  const entries = [...identifierMap.entries()].slice(0, LIMIT);
  console.log(`Fetching metadata for ${entries.length} albums...`);
  const albums = (await pMap(entries, buildAlbum)).filter(Boolean);
  console.log(`Parsed ${albums.length} usable albums`);

  const artistKeyMap = new Map();
  for (const album of albums) {
    artistKeyMap.set(album.artist.toLowerCase(), album.artist);
    for (const t of album.tracks) artistKeyMap.set(t.artist.toLowerCase(), t.artist);
  }
  const artists = [...artistKeyMap.values()].filter(Boolean).map((name) => [name, null]);

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const t0 = Date.now();
  try {
    await client.query('begin');

    console.log(`Upserting ${artists.length} artists...`);
    await upsertInBatches(
      client,
      `insert into public.artists (name, image_url)`,
      `on conflict (lower(name)) do update set image_url = coalesce(excluded.image_url, public.artists.image_url)`,
      artists, 2, 200
    );
    const artistRows = await client.query('select id, lower(name) as key from public.artists');
    const artistMap = new Map(artistRows.rows.map((r) => [r.key, r.id]));

    console.log(`Upserting ${albums.length} albums...`);
    await upsertInBatches(
      client,
      `insert into public.albums (external_id, title, artist_id, cover_url, release_year, genre, source)`,
      `on conflict (external_id) do update set
         title = excluded.title, artist_id = excluded.artist_id, cover_url = excluded.cover_url,
         release_year = excluded.release_year, genre = excluded.genre, source = excluded.source`,
      albums.map((a) => [
        a.external_id, a.title, artistMap.get(a.artist.toLowerCase()) || null,
        a.cover_url, a.release_year, a.genre, a.source,
      ]), 7, 200
    );
    const albumRows = await client.query('select id, external_id from public.albums');
    const albumMap = new Map(albumRows.rows.map((r) => [r.external_id, r.id]));

    const tracks = [];
    for (const album of albums) {
      const albumId = albumMap.get(album.external_id);
      if (!albumId) continue;
      for (const t of album.tracks) {
        tracks.push([
          t.external_id, t.title, artistMap.get(t.artist.toLowerCase()) || null, albumId,
          t.audio_url, t.cover_url, t.duration_ms, t.track_number, t.genre,
          t.release_year, t.license_url, 'archive', t.plays_count,
        ]);
      }
    }
    console.log(`Upserting ${tracks.length} tracks...`);
    await upsertInBatches(
      client,
      `insert into public.tracks
         (external_id, title, artist_id, album_id, audio_url, cover_url, duration_ms,
          track_number, genre, release_year, license_url, source, plays_count)`,
      `on conflict (external_id) do update set
         title = excluded.title, artist_id = excluded.artist_id, album_id = excluded.album_id,
         audio_url = excluded.audio_url, cover_url = excluded.cover_url,
         duration_ms = excluded.duration_ms, track_number = excluded.track_number,
         genre = excluded.genre, release_year = excluded.release_year,
         license_url = excluded.license_url, plays_count = excluded.plays_count`,
      tracks, 13, 300
    );

    await client.query('commit');

    const stats = await client.query(`
      select
        (select count(*) from public.artists) as artists,
        (select count(*) from public.albums) as albums,
        (select count(*) from public.tracks) as tracks,
        (select count(*) from public.tracks where duration_ms is not null) as with_duration,
        (select count(*) from public.tracks where cover_url is not null) as with_cover
    `);
    const genres = await client.query(`
      select genre, count(*)::int as n from public.tracks group by genre order by n desc limit 25
    `);
    console.log('\nDone in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    console.log('Catalog:', stats.rows[0]);
    console.log('Genres:');
    for (const g of genres.rows) console.log(`  ${g.genre}: ${g.n}`);
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
