-- ============================================================
-- GD4 Assistant — Stockage des données PAR COMPTE (Google/email)
--
-- ▶ À exécuter UNE fois : Dashboard Supabase (https://supabase.com/dashboard)
--   → projet loovbsraccdgofmakyqq → menu « SQL Editor » → coller → Run.
--
-- - public.user_chats    : une ligne par conversation (messages en JSONB).
-- - public.user_settings : préférences du compte (JSONB libre).
-- - RLS activée partout : chaque utilisateur ne peut lire/écrire que ses
--   propres lignes (auth.uid() = user_id). Les conversations ne sont donc
--   JAMAIS accessibles aux autres comptes, même avec la clé anon publique.
-- ============================================================

create table if not exists public.user_chats (
  id         text primary key,                 -- id généré par le client ('chat_<timestamp>')
  user_id    uuid        not null references auth.users (id) on delete cascade,
  title      text        not null default '',
  messages   jsonb       not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_settings (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_chats_user_updated
  on public.user_chats (user_id, updated_at desc);

alter table public.user_chats enable row level security;
alter table public.user_settings enable row level security;

-- ---------------- Policies user_chats ----------------
drop policy if exists "user_chats_select_own" on public.user_chats;
drop policy if exists "user_chats_insert_own" on public.user_chats;
drop policy if exists "user_chats_update_own" on public.user_chats;
drop policy if exists "user_chats_delete_own" on public.user_chats;

create policy "user_chats_select_own"
  on public.user_chats for select
  using (auth.uid() = user_id);

create policy "user_chats_insert_own"
  on public.user_chats for insert
  with check (auth.uid() = user_id);

create policy "user_chats_update_own"
  on public.user_chats for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "user_chats_delete_own"
  on public.user_chats for delete
  using (auth.uid() = user_id);

-- ---------------- Policies user_settings ----------------
drop policy if exists "user_settings_select_own" on public.user_settings;
drop policy if exists "user_settings_insert_own" on public.user_settings;
drop policy if exists "user_settings_update_own" on public.user_settings;
drop policy if exists "user_settings_delete_own" on public.user_settings;

create policy "user_settings_select_own"
  on public.user_settings for select
  using (auth.uid() = user_id);

create policy "user_settings_insert_own"
  on public.user_settings for insert
  with check (auth.uid() = user_id);

create policy "user_settings_update_own"
  on public.user_settings for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "user_settings_delete_own"
  on public.user_settings for delete
  using (auth.uid() = user_id);
