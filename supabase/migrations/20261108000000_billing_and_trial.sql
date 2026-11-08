-- World Explorer: Stripe subscription fields, free trial, and monthly AI caps.

-- ---------- subscription fields (written only by the stripe-webhook function) ----------
alter table public.profiles
  add column if not exists stripe_subscription_id text,
  add column if not exists subscription_status    text,
  add column if not exists current_period_end     timestamptz;

create index if not exists profiles_stripe_customer_idx on public.profiles (stripe_customer_id);

-- ---------- AI credits: daily, monthly and lifetime limits in one atomic check ----------
-- Pass null for a limit that doesn't apply. Free trial = lifetime limit only.
-- Pro = daily + monthly limits. A per-user advisory lock makes the sums race-free.
create or replace function public.consume_ai_credit(
  p_user uuid, p_daily integer, p_monthly integer, p_lifetime integer
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_day   integer;
  v_month integer;
  v_total integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));

  select coalesce(sum(count) filter (where day = v_today), 0),
         coalesce(sum(count) filter (where day >= date_trunc('month', v_today)::date), 0),
         coalesce(sum(count), 0)
    into v_day, v_month, v_total
    from public.ai_usage where user_id = p_user;

  if (p_daily    is not null and v_day   >= p_daily)
  or (p_monthly  is not null and v_month >= p_monthly)
  or (p_lifetime is not null and v_total >= p_lifetime) then
    return false;
  end if;

  insert into public.ai_usage (user_id, day, count) values (p_user, v_today, 1)
  on conflict (user_id, day) do update set count = public.ai_usage.count + 1;
  return true;
end;
$$;

revoke all on function public.consume_ai_credit(uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_ai_credit(uuid, integer, integer, integer) to service_role;

-- replaced by consume_ai_credit
drop function if exists public.consume_ai_quota(uuid, integer);
