-- World Explorer: accounts, synced progress, and AI usage limits.
-- Security model:
--   * Users can read their own profile but can NEVER change their tier.
--     Only the service role (Edge Functions / a future Stripe webhook) can.
--   * Users can read/write only their own progress row.
--   * AI usage is counted server-side by the `ai` Edge Function only.

-- ---------- profiles ----------
create table if not exists public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  tier               text not null default 'free' check (tier in ('free', 'pro')),
  stripe_customer_id text unique,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles
  for select to authenticated using (auth.uid() = id);
-- no insert/update/delete policies: clients cannot create or modify profiles

-- create a profile automatically for every new sign-up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  insert into public.user_progress (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end;
$$;

-- ---------- user_progress ----------
create table if not exists public.user_progress (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint progress_size check (pg_column_size(data) < 65536)
);

alter table public.user_progress enable row level security;

drop policy if exists "progress: read own" on public.user_progress;
create policy "progress: read own" on public.user_progress
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "progress: insert own" on public.user_progress;
create policy "progress: insert own" on public.user_progress
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "progress: update own" on public.user_progress;
create policy "progress: update own" on public.user_progress
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- ai_usage ----------
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day     date not null default (now() at time zone 'utc')::date,
  count   integer not null default 0,
  primary key (user_id, day)
);

alter table public.ai_usage enable row level security;

drop policy if exists "ai_usage: read own" on public.ai_usage;
create policy "ai_usage: read own" on public.ai_usage
  for select to authenticated using (auth.uid() = user_id);

-- Atomically take one AI credit for today. Returns false if the limit is reached.
create or replace function public.consume_ai_quota(p_user uuid, p_limit integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  insert into public.ai_usage (user_id, day, count)
  values (p_user, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day)
    do update set count = public.ai_usage.count + 1
    where public.ai_usage.count < p_limit
  returning count into v_count;
  return v_count is not null;
end;
$$;

-- Give a credit back when the AI call fails, so users aren't charged for errors.
create or replace function public.refund_ai_quota(p_user uuid)
returns void language sql security definer set search_path = public as $$
  update public.ai_usage set count = greatest(count - 1, 0)
  where user_id = p_user and day = (now() at time zone 'utc')::date;
$$;

-- Only the service role (Edge Functions) may call the quota functions.
revoke all on function public.consume_ai_quota(uuid, integer) from public, anon, authenticated;
revoke all on function public.refund_ai_quota(uuid) from public, anon, authenticated;
grant execute on function public.consume_ai_quota(uuid, integer) to service_role;
grant execute on function public.refund_ai_quota(uuid) to service_role;
