-- Pulse — aggregate views for browse/search screens, and a policy that lets
-- signed-in users add catalog artists (uploads reference them by name).

create or replace view public.genre_stats as
select
  genre,
  count(*)::int as track_count,
  count(distinct album_id)::int as album_count
from public.tracks
where genre is not null
group by genre;

create or replace view public.artist_stats as
select
  ar.id,
  ar.name,
  ar.image_url,
  count(t.id)::int as track_count,
  sum(t.plays_count)::bigint as total_plays
from public.artists ar
join public.tracks t on t.artist_id = ar.id
group by ar.id, ar.name, ar.image_url;

grant select on public.genre_stats to anon, authenticated;
grant select on public.artist_stats to anon, authenticated;

drop policy if exists artists_insert_auth on public.artists;
create policy artists_insert_auth on public.artists for insert to authenticated
  with check (length(name) > 0);
