-- ============================================================
--  ONEROUTE  –  Supabase schema
--  Run this once in the Supabase SQL Editor (project dashboard)
-- ============================================================

-- ── 1. profiles  (extends auth.users) ──────────────────────
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null default 'Driver',
  avatar_url  text,
  google_sub  text unique,
  terms_version text,
  terms_at    timestamptz,
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Users can read/write only their own profile
create policy "owner read"  on public.profiles for select using (auth.uid() = id);
create policy "owner write" on public.profiles for update using (auth.uid() = id);

-- Service role (server) can do everything
create policy "service all"
  on public.profiles for all
  using (true)
  with check (true);

-- Auto-create a profile row whenever a new auth user is created
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, name, created_at)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1), 'Driver'),
    now()
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ── 2. trips  (one row per active/completed trip) ──────────
create table if not exists public.trips (
  id           uuid primary key default gen_random_uuid(),
  code         text unique not null,
  host_id      uuid references public.profiles(id) on delete set null,
  name         text,
  destination  jsonb,          -- { lat, lng, name }
  waypoints    jsonb,          -- array
  route        jsonb,          -- encoded polyline / GeoJSON
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  meta         jsonb default '{}'::jsonb
);

alter table public.trips enable row level security;

create policy "service all" on public.trips for all using (true) with check (true);

-- ── 3. trip_members  (who is in the trip right now) ────────
create table if not exists public.trip_members (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips(id) on delete cascade,
  user_id    uuid references public.profiles(id) on delete set null,
  call_sign  text,
  role       text default 'driver',   -- 'driver' | 'leader' | 'sweeper'
  joined_at  timestamptz not null default now(),
  left_at    timestamptz
);

alter table public.trip_members enable row level security;
create policy "service all" on public.trip_members for all using (true) with check (true);

-- ── 4. trip_locations  (location pings) ────────────────────
create table if not exists public.trip_locations (
  id         bigint generated always as identity primary key,
  trip_id    uuid not null references public.trips(id) on delete cascade,
  user_id    uuid references public.profiles(id) on delete set null,
  lat        double precision not null,
  lng        double precision not null,
  accuracy   real,
  speed      real,
  heading    real,
  recorded_at timestamptz not null default now()
);

alter table public.trip_locations enable row level security;
create policy "service all" on public.trip_locations for all using (true) with check (true);

-- index to make "latest ping per user in trip" fast
create index if not exists trip_locations_trip_user
  on public.trip_locations (trip_id, user_id, recorded_at desc);

-- ── 5. trip_events  (stops, pins, messages, SOS …) ─────────
create table if not exists public.trip_events (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips(id) on delete cascade,
  user_id    uuid references public.profiles(id) on delete set null,
  kind       text not null,   -- 'stop' | 'pin' | 'message' | 'sos' | 'quick'
  payload    jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.trip_events enable row level security;
create policy "service all" on public.trip_events for all using (true) with check (true);

create index if not exists trip_events_trip_id on public.trip_events (trip_id, created_at desc);
