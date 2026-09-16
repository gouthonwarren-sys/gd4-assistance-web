-- ============================================================
-- GD4 Assistant — Quota par compte + Codes d'appairage plugin
--
-- ▶ À exécuter dans Dashboard Supabase → SQL Editor (après 001_gd4_user_data.sql).
--
-- - public.user_quotas       : compteur de requêtes IA PAR COMPTE, avec fenêtre
--                              de réinitialisation (8 h par défaut).
-- - public.user_pairing_codes: code d'appairage du plugin Godot PAR COMPTE —
--                              donnée stratégique stockée côté serveur.
-- - RPC consume_quota()      : décrément ATOMIQUE côté serveur → le quota ne
--                              peut plus être contourné en vidant le localStorage.
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

-- ---------------- RPC : décrément atomique du quota ----------------
-- SECURITY DEFINER : s'exécute avec les droits du propriétaire → contourne la
-- RLS pour l'upsert, mais vérifie auth.uid() elle-même. L'appel anonyme est refusé.
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

-- Réservée aux utilisateurs connectés
revoke execute on function public.consume_quota(integer, integer) from anon, public;
grant execute on function public.consume_quota(integer, integer) to authenticated;
