-- Pulse — initial schema
-- Backend: Supabase (Postgres 17)
-- Tables, indexes, triggers, RLS policies, storage buckets.

-- ---------- Tables ----------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.artists (
  id bigint generated always as identity primary key,
  name text not null,
  image_url text,
  bio text,
  created_at timestamptz not null default now()
);

create table if not exists public.albums (
  id bigint generated always as identity primary key,
  title text not null,
  artist_id bigint references public.artists(id) on delete set null,
  cover_url text,
  release_year int,
  genre text,
  source text not null default 'archive',
  external_id text not null default gen_random_uuid()::text,
  created_at timestamptz not null default now()
);

create table if not exists public.tracks (
  id bigint generated always as identity primary key,
  title text not null,
  artist_id bigint references public.artists(id) on delete set null,
  album_id bigint references public.albums(id) on delete set null,
  audio_url text not null,
  storage_path text,
  cover_url text,
  duration_ms int,
  track_number int,
  genre text,
  release_year int,
  license_url text,
  plays_count bigint not null default 0,
  source text not null default 'archive',
  external_id text not null default gen_random_uuid()::text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.playlists (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  cover_url text,
  is_public boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.playlist_tracks (
  playlist_id bigint not null references public.playlists(id) on delete cascade,
  track_id bigint not null references public.tracks(id) on delete cascade,
  position int not null default 0,
  added_at timestamptz not null default now(),
  primary key (playlist_id, track_id)
);

create table if not exists public.likes (
  user_id uuid not null references auth.users(id) on delete cascade,
  track_id bigint not null references public.tracks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, track_id)
);

create table if not exists public.play_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  track_id bigint not null references public.tracks(id) on delete cascade,
  played_at timestamptz not null default now()
);

create table if not exists public.follows (
  user_id uuid not null references auth.users(id) on delete cascade,
  artist_id bigint not null references public.artists(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, artist_id)
);

-- ---------- Indexes ----------

create index if not exists tracks_title_idx on public.tracks (lower(title));
create index if not exists tracks_genre_idx on public.tracks (genre);
create index if not exists tracks_artist_idx on public.tracks (artist_id);
create index if not exists tracks_album_idx on public.tracks (album_id);
create index if not exists tracks_plays_idx on public.tracks (plays_count desc);
create index if not exists albums_title_idx on public.albums (lower(title));
create index if not exists albums_artist_idx on public.albums (artist_id);
create index if not exists artists_name_idx on public.artists (lower(name));
create index if not exists playlist_tracks_playlist_idx on public.playlist_tracks (playlist_id, position);
create index if not exists likes_user_idx on public.likes (user_id);
create index if not exists play_history_user_idx on public.play_history (user_id, played_at desc);
create index if not exists follows_user_idx on public.follows (user_id);

create unique index if not exists artists_name_unique on public.artists (lower(name));
create unique index if not exists albums_external_id_unique on public.albums (external_id);
create unique index if not exists tracks_external_id_unique on public.tracks (external_id);

-- ---------- Functions & triggers ----------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.increment_track_plays()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tracks set plays_count = plays_count + 1 where id = new.track_id;
  return new;
end;
$$;

drop trigger if exists play_history_insert on public.play_history;
create trigger play_history_insert
  after insert on public.play_history
  for each row execute procedure public.increment_track_plays();

-- ---------- Row level security ----------

alter table public.profiles enable row level security;
alter table public.artists enable row level security;
alter table public.albums enable row level security;
alter table public.tracks enable row level security;
alter table public.playlists enable row level security;
alter table public.playlist_tracks enable row level security;
alter table public.likes enable row level security;
alter table public.play_history enable row level security;
alter table public.follows enable row level security;

-- profiles
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select to authenticated using (auth.uid() = id);
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- catalog reads are public
drop policy if exists artists_select_all on public.artists;
create policy artists_select_all on public.artists for select to anon, authenticated using (true);
drop policy if exists albums_select_all on public.albums;
create policy albums_select_all on public.albums for select to anon, authenticated using (true);
drop policy if exists tracks_select_all on public.tracks;
create policy tracks_select_all on public.tracks for select to anon, authenticated using (true);

-- uploads: a user may only add tracks they own, and only as source 'upload'
drop policy if exists tracks_insert_auth on public.tracks;
create policy tracks_insert_auth on public.tracks for insert to authenticated
  with check (created_by = auth.uid() and source = 'upload');
drop policy if exists tracks_update_own on public.tracks;
create policy tracks_update_own on public.tracks for update to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid());

-- playlists
drop policy if exists playlists_select_all on public.playlists;
create policy playlists_select_all on public.playlists for select to anon, authenticated using (true);
drop policy if exists playlists_insert_auth on public.playlists;
create policy playlists_insert_auth on public.playlists for insert to authenticated with check (user_id = auth.uid());
drop policy if exists playlists_update_own on public.playlists;
create policy playlists_update_own on public.playlists for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists playlists_delete_own on public.playlists;
create policy playlists_delete_own on public.playlists for delete to authenticated using (user_id = auth.uid());

-- playlist_tracks: readable by all, writable by the playlist owner
drop policy if exists playlist_tracks_select_all on public.playlist_tracks;
create policy playlist_tracks_select_all on public.playlist_tracks for select to anon, authenticated using (true);
drop policy if exists playlist_tracks_insert_owner on public.playlist_tracks;
create policy playlist_tracks_insert_owner on public.playlist_tracks for insert to authenticated
  with check (exists (select 1 from public.playlists p where p.id = playlist_id and p.user_id = auth.uid()));
drop policy if exists playlist_tracks_update_owner on public.playlist_tracks;
create policy playlist_tracks_update_owner on public.playlist_tracks for update to authenticated
  using (exists (select 1 from public.playlists p where p.id = playlist_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.playlists p where p.id = playlist_id and p.user_id = auth.uid()));
drop policy if exists playlist_tracks_delete_owner on public.playlist_tracks;
create policy playlist_tracks_delete_owner on public.playlist_tracks for delete to authenticated
  using (exists (select 1 from public.playlists p where p.id = playlist_id and p.user_id = auth.uid()));

-- likes
drop policy if exists likes_select_own on public.likes;
create policy likes_select_own on public.likes for select to authenticated using (user_id = auth.uid());
drop policy if exists likes_insert_own on public.likes;
create policy likes_insert_own on public.likes for insert to authenticated with check (user_id = auth.uid());
drop policy if exists likes_delete_own on public.likes;
create policy likes_delete_own on public.likes for delete to authenticated using (user_id = auth.uid());

-- play_history
drop policy if exists play_history_select_own on public.play_history;
create policy play_history_select_own on public.play_history for select to authenticated using (user_id = auth.uid());
drop policy if exists play_history_insert_own on public.play_history;
create policy play_history_insert_own on public.play_history for insert to authenticated with check (user_id = auth.uid());
drop policy if exists play_history_delete_own on public.play_history;
create policy play_history_delete_own on public.play_history for delete to authenticated using (user_id = auth.uid());

-- follows
drop policy if exists follows_select_own on public.follows;
create policy follows_select_own on public.follows for select to authenticated using (user_id = auth.uid());
drop policy if exists follows_insert_own on public.follows;
create policy follows_insert_own on public.follows for insert to authenticated with check (user_id = auth.uid());
drop policy if exists follows_delete_own on public.follows;
create policy follows_delete_own on public.follows for delete to authenticated using (user_id = auth.uid());

-- ---------- Storage ----------

insert into storage.buckets (id, name, public) values
  ('uploads', 'uploads', false),
  ('covers', 'covers', true)
on conflict (id) do nothing;

drop policy if exists uploads_owner_select on storage.objects;
create policy uploads_owner_select on storage.objects for select to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists uploads_owner_insert on storage.objects;
create policy uploads_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists uploads_owner_update on storage.objects;
create policy uploads_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists uploads_owner_delete on storage.objects;
create policy uploads_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists covers_public_read on storage.objects;
create policy covers_public_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'covers');
drop policy if exists covers_owner_insert on storage.objects;
create policy covers_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists covers_owner_delete on storage.objects;
create policy covers_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);
