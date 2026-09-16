-- ============================================================
-- GD4 — SQL TOUT-EN-UN : colle CE fichier entier dans le SQL Editor
-- Supabase (une seule fois). Idempotent : sans danger si déjà exécuté.
-- Contient : 002_quota_pairing.sql + 003_token_quota_promo.sql
-- ============================================================

-- ============================================================
-- GD4 Assistant â€” Quota par compte + Codes d'appairage plugin
--
-- â–¶ Ã€ exÃ©cuter dans Dashboard Supabase â†’ SQL Editor (aprÃ¨s 001_gd4_user_data.sql).
--
-- - public.user_quotas       : compteur de requÃªtes IA PAR COMPTE, avec fenÃªtre
--                              de rÃ©initialisation (8 h par dÃ©faut).
-- - public.user_pairing_codes: code d'appairage du plugin Godot PAR COMPTE â€”
--                              donnÃ©e stratÃ©gique stockÃ©e cÃ´tÃ© serveur.
-- - RPC consume_quota()      : dÃ©crÃ©ment ATOMIQUE cÃ´tÃ© serveur â†’ le quota ne
--                              peut plus Ãªtre contournÃ© en vidant le localStorage.
-- ============================================================

create table if not exists public.user_quotas (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  used        integer     not null default 0,
  quota_limit integer     not null default 50,
  reset_at    timestamptz not null default now() + interval '8 hours',
  updated_at  timestamptz not null default now()
);

create table if not exists public.user_pairing_codes (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  code        text        not null unique,
  owner_email text        not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_user_pairing_codes_code
  on public.user_pairing_codes (code);

alter table public.user_quotas enable row level security;
alter table public.user_pairing_codes enable row level security;

-- ---------------- Policies user_quotas ----------------
drop policy if exists "user_quotas_select_own" on public.user_quotas;
drop policy if exists "user_quotas_insert_own" on public.user_quotas;
drop policy if exists "user_quotas_update_own" on public.user_quotas;
drop policy if exists "user_quotas_delete_own" on public.user_quotas;

create policy "user_quotas_select_own"
  on public.user_quotas for select using (auth.uid() = user_id);
create policy "user_quotas_insert_own"
  on public.user_quotas for insert with check (auth.uid() = user_id);
create policy "user_quotas_update_own"
  on public.user_quotas for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "user_quotas_delete_own"
  on public.user_quotas for delete using (auth.uid() = user_id);

-- ---------------- Policies user_pairing_codes ----------------
drop policy if exists "user_pairing_select_own" on public.user_pairing_codes;
drop policy if exists "user_pairing_insert_own" on public.user_pairing_codes;
drop policy if exists "user_pairing_update_own" on public.user_pairing_codes;
drop policy if exists "user_pairing_delete_own" on public.user_pairing_codes;

create policy "user_pairing_select_own"
  on public.user_pairing_codes for select using (auth.uid() = user_id);
create policy "user_pairing_insert_own"
  on public.user_pairing_codes for insert with check (auth.uid() = user_id);
create policy "user_pairing_update_own"
  on public.user_pairing_codes for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "user_pairing_delete_own"
  on public.user_pairing_codes for delete using (auth.uid() = user_id);

-- ---------------- RPC : dÃ©crÃ©ment atomique du quota ----------------
-- SECURITY DEFINER : s'exÃ©cute avec les droits du propriÃ©taire â†’ contourne la
-- RLS pour l'upsert, mais vÃ©rifie auth.uid() elle-mÃªme. L'appel anonyme est refusÃ©.
create or replace function public.consume_quota(p_limit integer default 50, p_window_hours integer default 8)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_row  public.user_quotas;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'remaining', 0, 'limit', p_limit, 'error', 'not_authenticated');
  end if;

  insert into public.user_quotas (user_id, used, quota_limit, reset_at)
    values (v_user, 1, p_limit, now() + make_interval(hours => p_window_hours))
  on conflict (user_id) do update set
    used        = case when public.user_quotas.reset_at <= now()
                       then 1 else public.user_quotas.used + 1 end,
    quota_limit = p_limit,
    reset_at    = case when public.user_quotas.reset_at <= now()
                       then now() + make_interval(hours => p_window_hours)
                       else public.user_quotas.reset_at end,
    updated_at  = now()
  returning * into v_row;

  return jsonb_build_object(
    'ok',        v_row.used <= p_limit,
    'remaining', greatest(0, p_limit - v_row.used),
    'limit',     p_limit,
    'reset_at',  v_row.reset_at
  );
end $$;

-- RÃ©servÃ©e aux utilisateurs connectÃ©s
revoke execute on function public.consume_quota(integer, integer) from anon, public;
grant execute on function public.consume_quota(integer, integer) to authenticated;

-- ============================================================
-- GD4 â€” Quota TOKENS + Codes promo (003)
-- SQL Editor Supabase, APRES 001 et 002.
create table if not exists public.user_token_quotas (
  user_id uuid primary key references auth.users (id) on delete cascade,
  used_input integer not null default 0,
  used_output integer not null default 0,
  limit_input integer not null default 18000,
  limit_output integer not null default 7000,
  reset_at timestamptz not null default now() + interval '8 hours',
  updated_at timestamptz not null default now()
);
create table if not exists public.user_promo_uses (
  user_id uuid not null references auth.users (id) on delete cascade,
  code text not null,
  used_at timestamptz not null default now(),
  primary key (user_id, code)
);
create index if not exists idx_user_promo_uses_code on public.user_promo_uses (code);
alter table public.user_token_quotas enable row level security;
alter table public.user_promo_uses enable row level security;
drop policy if exists "user_token_quotas_select_own" on public.user_token_quotas;
drop policy if exists "user_token_quotas_insert_own" on public.user_token_quotas;
drop policy if exists "user_token_quotas_update_own" on public.user_token_quotas;
drop policy if exists "user_token_quotas_delete_own" on public.user_token_quotas;
create policy "user_token_quotas_select_own" on public.user_token_quotas for select using (auth.uid() = user_id);
create policy "user_token_quotas_insert_own" on public.user_token_quotas for insert with check (auth.uid() = user_id);
create policy "user_token_quotas_update_own" on public.user_token_quotas for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "user_token_quotas_delete_own" on public.user_token_quotas for delete using (auth.uid() = user_id);
drop policy if exists "user_promo_uses_select_own" on public.user_promo_uses;
drop policy if exists "user_promo_uses_insert_own" on public.user_promo_uses;
create policy "user_promo_uses_select_own" on public.user_promo_uses for select using (auth.uid() = user_id);
create policy "user_promo_uses_insert_own" on public.user_promo_uses for insert with check (auth.uid() = user_id);

-- RPC consommation atomique input+output (fenÃªtre 8h).
create or replace function public.consume_token_quota(
  p_input_tokens integer default 1,
  p_output_tokens integer default 1,
  p_window_hours integer default 8,
  p_default_input integer default 18000,
  p_default_output integer default 7000
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_row public.user_token_quotas;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'remainingInput', 0,
      'remainingOutput', 0, 'limitInput', p_default_input,
      'limitOutput', p_default_output, 'error', 'not_authenticated');
  end if;
  insert into public.user_token_quotas
    (user_id, used_input, used_output, limit_input, limit_output, reset_at)
    values (v_user, p_input_tokens, p_output_tokens,
      p_default_input, p_default_output,
      now() + make_interval(hours => p_window_hours))
  on conflict (user_id) do update set
    used_input = case when public.user_token_quotas.reset_at <= now()
      then p_input_tokens
      else public.user_token_quotas.used_input + p_input_tokens end,
    used_output = case when public.user_token_quotas.reset_at <= now()
      then p_output_tokens
      else public.user_token_quotas.used_output + p_output_tokens end,
    limit_input = case when public.user_token_quotas.reset_at <= now()
      then p_default_input else public.user_token_quotas.limit_input end,
    limit_output = case when public.user_token_quotas.reset_at <= now()
      then p_default_output else public.user_token_quotas.limit_output end,
    reset_at = case when public.user_token_quotas.reset_at <= now()
      then now() + make_interval(hours => p_window_hours)
      else public.user_token_quotas.reset_at end,
    updated_at = now()
  returning * into v_row;
  return jsonb_build_object(
    'ok', (v_row.used_input <= v_row.limit_input)
      and (v_row.used_output <= v_row.limit_output),
    'remainingInput', greatest(0, v_row.limit_input - v_row.used_input),
    'remainingOutput', greatest(0, v_row.limit_output - v_row.used_output),
    'limitInput', v_row.limit_input,
    'limitOutput', v_row.limit_output,
    'resetAt', v_row.reset_at
  );
end $$;

-- Consommation rÃ©servÃ©e aux utilisateurs connectÃ©s (via RLS + SECURITY DEFINER).
revoke execute on function
  public.consume_token_quota(integer, integer, integer, integer, integer)
  from anon, public;
grant execute on function
  public.consume_token_quota(integer, integer, integer, integer, integer)
  to authenticated;

-- RPC bonus code promo (appel SERVEUR service_role uniquement).
create or replace function public.apply_promo_bonus(
  p_user uuid, p_code text,
  p_bonus_input integer default 0, p_bonus_output integer default 0,
  p_max_uses integer default 1,
  p_window_hours integer default 8,
  p_default_input integer default 18000, p_default_output integer default 7000
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_row public.user_token_quotas;
  v_count integer;
begin
  if p_user is null or p_code is null or p_code = '' then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;
  if exists (select 1 from public.user_promo_uses where user_id = p_user and code = p_code) then
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;
  select count(*) into v_count from public.user_promo_uses where code = p_code;
  if v_count >= greatest(1, coalesce(p_max_uses, 1)) then
    return jsonb_build_object('ok', false, 'error', 'max_uses_reached');
  end if;
  begin
    insert into public.user_promo_uses (user_id, code) values (p_user, p_code);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end;
  insert into public.user_token_quotas
    (user_id, used_input, used_output, limit_input, limit_output, reset_at)
    values (p_user, 0, 0,
      p_default_input + greatest(0, coalesce(p_bonus_input, 0)),
      p_default_output + greatest(0, coalesce(p_bonus_output, 0)),
      now() + make_interval(hours => p_window_hours))
  on conflict (user_id) do update set
    limit_input = case when public.user_token_quotas.reset_at <= now()
      then p_default_input + greatest(0, coalesce(p_bonus_input, 0))
      else public.user_token_quotas.limit_input + greatest(0, coalesce(p_bonus_input, 0)) end,
    limit_output = case when public.user_token_quotas.reset_at <= now()
      then p_default_output + greatest(0, coalesce(p_bonus_output, 0))
      else public.user_token_quotas.limit_output + greatest(0, coalesce(p_bonus_output, 0)) end,
    used_input = case when public.user_token_quotas.reset_at <= now()
      then 0 else public.user_token_quotas.used_input end,
    used_output = case when public.user_token_quotas.reset_at <= now()
      then 0 else public.user_token_quotas.used_output end,
    reset_at = case when public.user_token_quotas.reset_at <= now()
      then now() + make_interval(hours => p_window_hours)
      else public.user_token_quotas.reset_at end,
    updated_at = now()
  returning * into v_row;
  return jsonb_build_object('ok', true,
    'limit_input', v_row.limit_input, 'limit_output', v_row.limit_output,
    'remaining_input', greatest(0, v_row.limit_input - v_row.used_input),
    'remaining_output', greatest(0, v_row.limit_output - v_row.used_output),
    'reset_at', v_row.reset_at);
end $$;
revoke execute on function
  public.apply_promo_bonus(uuid, text, integer, integer, integer, integer, integer, integer)
  from anon, authenticated, public;
grant execute on function
  public.apply_promo_bonus(uuid, text, integer, integer, integer, integer, integer, integer)
  to service_role;

