create table if not exists public.oneroute_account_store (
  id integer primary key check (id = 1),
  revision bigint not null default 0,
  snapshot jsonb not null
);

alter table public.oneroute_account_store enable row level security;
revoke all on public.oneroute_account_store from public, anon, authenticated;
grant select, insert, update on public.oneroute_account_store to service_role;
