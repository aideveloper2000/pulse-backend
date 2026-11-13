# Pulse — backend

Supabase backend for **Pulse**, a music streaming app (web + mobile interfaces).

- **Project:** Supabase `pulse-music` — ref `pgbmgjgzsfozkobnvwna` (region `ap-southeast-1`)
- **Database:** Postgres 17
- **Auth:** email + password (email confirmation disabled for this personal project)
- **Storage:** `uploads` (private, per-user folders, signed URLs) and `covers` (public)

## Layout

```
supabase/
  migrations/
    0001_init.sql   # tables, indexes, triggers, RLS policies, storage buckets
    0002_views.sql  # genre_stats / artist_stats views + artist insert policy
  seed/
    seed.mjs        # loads the catalog from the Internet Archive
package.json        # `npm run migrate` and `npm run seed`
```

## Schema

| Table | Purpose |
| --- | --- |
| `profiles` | one row per auth user (created by trigger) |
| `artists` | artists, deduped case-insensitively by name |
| `albums` | albums, with cover, year, genre, and a source tag |
| `tracks` | audio tracks: public URL or a private `storage_path`, duration, genre, play count |
| `playlists` / `playlist_tracks` | user playlists and their ordered tracks |
| `likes` | liked songs |
| `play_history` | plays, with a trigger that increments `tracks.plays_count` |
| `follows` | artist follows |

`genre_stats` and `artist_stats` are read-only aggregate views for browse screens.

## Row level security

- Anonymous visitors can **read** the catalog (tracks, albums, artists, playlists).
- Only signed-in users can write, and only to their own rows (`auth.uid()` checks).
- Uploaded tracks can only be created with `source = 'upload'` and `created_by = auth.uid()`.
- Storage objects live under `<user_id>/…`; only the owner can read or delete them.

## Catalog

The catalog is seeded from the **Internet Archive**'s freely-licensed collections
(Free Music Archive, netlabels, 78rpm) — roughly **10,000 tracks** across 23 genres,
with cover art, durations, and per-track license URLs. Audio streams directly from
`archive.org`; nothing is hosted on Supabase.

> This is not Spotify's catalog. Spotify's catalogue cannot be licensed or dumped into
> a third-party app, and its terms forbid full-song playback outside Spotify's clients.

## Commands

```bash
npm install
cp .env.example .env   # DATABASE_URL=postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres
npm run migrate        # apply migrations (idempotent)
npm run seed           # load the catalog (idempotent upserts; --limit N for a subset)
```

Get the database password and project ref from the Supabase dashboard, or reset the
password with the Management API (`POST /v1/projects/{ref}/database/password`).
