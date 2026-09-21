// ============================================================
// GD4 Assistant — Données par compte Google/email
//
// Chaque clé localStorage est séparée par compte (::u:<uid>) et les
// données sont synchronisées silencieusement vers Supabase
// (tables user_chats / user_settings protégées par RLS côté serveur).
//
// - Déconnecté  → comportement historique (clés globales "anonyme").
// - Connecté    → cache local du compte d'abord (résultat instantané et
//                 utilisable hors-ligne), puis synchro cloud best-effort :
//                 rien ne casse si le réseau ou la base est indisponible.
// ============================================================

import { supabase } from './supabase';
import {
  getManualProjectContext,
  setManualProjectContext,
  exportScopeSnapshot,
  importScopeSnapshot,
  mergeScopeMemory,
  deleteScopeMemory,
  mergeConversationHubIntoProject,
} from './projectMemory';

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  modelName?: string;
  /** Horodatage (epoch ms) — affiché comme l'heure dans le plugin. Optionnel (anciens messages). */
  createdAt?: number;
}

export interface Chat {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt?: number; // epoch ms — utilisé pour la fusion locale/cloud
}

export interface AccountInfo {
  id: string;
  email: string;
}

export interface QuotaState {
  email: string;
  used: number;
  limit: number;
  reset: number;
}

// ---------- Clés de stockage ----------
const CHATS_BASE_KEY = 'gd4_chats_history';          // sans suffixe = bucket "anonyme" (ancien format)
const ACTIVE_CHAT_BASE_KEY = 'gd4_active_chat_id';
const SETTINGS_BASE_KEY = 'gd4_account_settings';
const QUOTA_LEGACY_KEY = 'gd4_quota';
const PROMPT_LEGACY_KEY = 'gd4_system_prompt';
const SESSION_CACHE_KEY = 'gd4_user_session';
const MIGRATION_FLAG_KEY = 'gd4_legacy_migrated_v1';

/** Préfixe une clé avec l'identifiant du compte (aucun si anonyme). */
function nsKey(baseKey: string, userId: string | null): string {
  return userId ? `${baseKey}::u:${userId}` : baseKey;
}

// ============================================================
// IDENTITÉ DU COMPTE
// ============================================================

/** Infos compte depuis le cache de session écrit à chaque changement d'état Auth. */
export function getUserFromCache(): AccountInfo | null {
  try {
    const raw = localStorage.getItem(SESSION_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.id === 'string' && parsed.id) {
      return { id: parsed.id, email: typeof parsed.email === 'string' ? parsed.email : '' };
    }
  } catch { /* cache corrompu → ignoré */ }
  return null;
}

/** Identité fiable sans bloquer : cache immédiat, sinon session Supabase locale (lecture storage). */
export async function resolveCurrentUser(maxWaitMs = 1500): Promise<AccountInfo | null> {
  const cached = getUserFromCache();
  if (cached) return cached;
  try {
    const result = await Promise.race([
      supabase.auth.getSession(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), maxWaitMs)),
    ]) as Awaited<ReturnType<typeof supabase.auth.getSession>>;
    const user = result.data?.session?.user;
    if (user?.id) return { id: user.id, email: user.email || '' };
  } catch { /* hors-ligne ou timeout → anonyme */ }
  return null;
}

// ============================================================
// CONVERSATIONS — cache local PAR COMPTE
// ============================================================

function parseChats(raw: string | null): Chat[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((c: any) => c && typeof c.id === 'string')
      .map((c: any) => ({
        id: c.id,
        title: typeof c.title === 'string' ? c.title : 'Conversation',
        messages: Array.isArray(c.messages) ? c.messages.filter((m: any) => m && typeof m.text === 'string') : [],
        updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : undefined,
      }));
  } catch {
    return [];
  }
}

function sortChats(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** Conversations du compte courant (anonyme inclus) — lecture SYNCHRONE, instantanée. */
export function getChats(userId: string | null): Chat[] {
  try {
    return parseChats(localStorage.getItem(nsKey(CHATS_BASE_KEY, userId)));
  } catch {
    return [];
  }
}

function persistLocalChats(chats: Chat[], userId: string | null): void {
  localStorage.setItem(nsKey(CHATS_BASE_KEY, userId), JSON.stringify(chats));
}

function chatToRow(chat: Chat, userId: string) {
  return {
    id: chat.id,
    user_id: userId,
    title: chat.title,
    messages: chat.messages,
    updated_at: new Date(chat.updatedAt ?? Date.now()).toISOString(),
  };
}

/**
 * Ajoute/remplace une conversation :
 * 1) écriture immédiate dans le cache LOCAL du compte (+ événement UI),
 * 2) synchro cloud en arrière-plan (silencieuse si HS/déconnecté).
 */
export async function upsertChat(chat: Chat, userId: string | null): Promise<void> {
  if (!chat?.id) return;
  const touched: Chat = {
    id: chat.id,
    title: chat.title || '',
    messages: Array.isArray(chat.messages) ? chat.messages : [],
    updatedAt: Date.now(),
  };
  const others = getChats(userId).filter((c) => c.id !== touched.id);
  persistLocalChats(sortChats([touched, ...others]), userId);
  window.dispatchEvent(new CustomEvent('chats-updated'));

  if (!userId) return;
  try {
    const { error } = await supabase.from('user_chats').upsert(chatToRow(touched, userId), { onConflict: 'id' });
    if (error) console.warn('[GD4] Synchro conversation impossible :', error.message);
  } catch (e: any) {
    console.warn('[GD4] Synchro conversation impossible :', e?.message || e);
  }
}

/** Supprime une conversation localement + cloud (si connecté). */
export async function removeChat(chatId: string, userId: string | null): Promise<void> {
  persistLocalChats(getChats(userId).filter((c) => c.id !== chatId), userId);
  window.dispatchEvent(new CustomEvent('chats-updated'));
  if (!userId) return;
  try {
    const { error } = await supabase.from('user_chats').delete().eq('id', chatId);
    if (error) console.warn('[GD4] Suppression cloud impossible :', error.message);
  } catch (e: any) {
    console.warn('[GD4] Suppression cloud impossible :', e?.message || e);
  }
}

// ============================================================
// CONVERSATION ACTIVE — par compte
// ============================================================

export function getActiveChatId(userId: string | null): string | null {
  return localStorage.getItem(nsKey(ACTIVE_CHAT_BASE_KEY, userId));
}

export function setActiveChatId(chatId: string | null, userId: string | null): void {
  const key = nsKey(ACTIVE_CHAT_BASE_KEY, userId);
  if (chatId) localStorage.setItem(key, chatId);
  else localStorage.removeItem(key);
}

// ============================================================
// PRÉFÉRENCES (« autres » données : system prompt, etc.)
// ============================================================

type SettingsBlob = Record<string, unknown>;

function readSettings(userId: string | null): SettingsBlob {
  try {
    const raw = localStorage.getItem(nsKey(SETTINGS_BASE_KEY, userId));
    return raw ? (JSON.parse(raw) ?? {}) : {};
  } catch {
    return {};
  }
}

async function persistSettings(blob: SettingsBlob, userId: string | null): Promise<void> {
  localStorage.setItem(nsKey(SETTINGS_BASE_KEY, userId), JSON.stringify(blob));
  if (!userId) return;
  try {
    const { error } = await supabase
      .from('user_settings')
      .upsert({ user_id: userId, data: blob }, { onConflict: 'user_id' });
    if (error) console.warn('[GD4] Synchro préférences impossible :', error.message);
  } catch (e: any) {
    console.warn('[GD4] Synchro préférences impossible :', e?.message || e);
  }
}

export function getSetting<T>(userId: string | null, key: string, fallback: T): T {
  const value = readSettings(userId)[key];
  return (value === undefined ? fallback : value) as T;
}

/** Sauvegarde une préférence dans l'espace du compte (+ cloud si connecté). */
export async function setSetting(userId: string | null, key: string, value: unknown): Promise<void> {
  const blob = readSettings(userId);
  blob[key] = value;
  await persistSettings(blob, userId);
}

// --- System prompt ---
export function getSystemPrompt(userId: string | null): string {
  if (userId) return getSetting<string>(userId, 'systemPrompt', '');
  // Anonyme → ancienne clé globale
  try { return localStorage.getItem(PROMPT_LEGACY_KEY) || ''; } catch { return ''; }
}

export async function setSystemPrompt(prompt: string, userId: string | null): Promise<void> {
  if (userId) {
    await setSetting(userId, 'systemPrompt', prompt);
    return;
  }
  try {
    if (prompt) localStorage.setItem(PROMPT_LEGACY_KEY, prompt);
    else localStorage.removeItem(PROMPT_LEGACY_KEY);
  } catch { /* stockage indisponible */ }
}

// --- Mémoire projet globale ---
export function getProjectMemoryText(userId: string | null): string {
  const inMemory = getManualProjectContext(userId);
  if (inMemory) return inMemory;
  return getSetting<string>(userId, 'projectMemoryText', '');
}

export async function setProjectMemoryText(value: string, userId: string | null): Promise<void> {
  const normalized = (value ?? '').trim();
  setManualProjectContext(userId, normalized);
  await setSetting(userId, 'projectMemoryText', normalized);
}

// ============================================================
// 🗂️ CENTRE DE DONNÉES — ENREGISTRÉ DANS LE COMPTE (local + cloud)
// Chaque PROJET et chaque CONVERSATION LIBRE a son propre centre de données.
// Quand une conversation rejoint un projet, son hub est FUSIONNÉ dans celui du
// projet : rien n'est perdu, et deux projets de jeu ne se mélangent jamais.
// ============================================================
const HUB_SETTING_KEY = 'projectHubScopes';
let hubSyncTimer: number | null = null;

/** Envoie le centre de données du compte dans `user_settings` (cloud). */
export async function syncHubToCloud(userId: string | null): Promise<void> {
  if (!userId) return;
  await setSetting(userId, HUB_SETTING_KEY, exportScopeSnapshot(userId));
}

/** Restaure le centre de données du compte (fusion sans écrasement). */
export async function restoreHubFromCloud(userId: string | null): Promise<number> {
  if (!userId) return 0;
  const snapshot = getSetting<unknown>(userId, HUB_SETTING_KEY, null);
  const merged = importScopeSnapshot(userId, snapshot);
  if (merged) window.dispatchEvent(new CustomEvent('data-hub-updated'));
  return merged;
}

/** Sauvegarde différée (2 s) : on n'écrit pas dans le cloud à chaque message. */
export function scheduleHubCloudSync(): void {
  try {
    if (hubSyncTimer !== null) window.clearTimeout(hubSyncTimer);
    hubSyncTimer = window.setTimeout(() => {
      hubSyncTimer = null;
      void syncHubToCloud(getUserFromCache()?.id ?? null);
    }, 2000);
  } catch { /* stockage indisponible */ }
}

if (typeof window !== 'undefined') {
  // 🔔 Toute écriture du hub (IA, utilisateur, fusion, vidage) → sauvegardée
  window.addEventListener('gd4-memory-changed', () => scheduleHubCloudSync());
}

// ============================================================
// 📁 PROJETS — dossiers de conversations (nom + description)
// ------------------------------------------------------------
// Un projet range des conversations et sa DESCRIPTION est injectée
// dans le prompt système de chaque conversation qu'il contient.
// Stockage : réglages du compte (user_settings.data) → synchro cloud
// automatique, AUCUNE migration SQL nécessaire.
//   - projects        : Project[]
//   - chatProjects    : { [chatId]: projectId }
//   - activeProjectId : projet par défaut des nouvelles conversations
// ============================================================

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

const PROJECTS_SETTING_KEY = 'projects';
const CHAT_PROJECTS_SETTING_KEY = 'chatProjects';
const ACTIVE_PROJECT_SETTING_KEY = 'activeProjectId';

function normalizeProject(raw: any): Project | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Projet',
    description: typeof raw.description === 'string' ? raw.description : '',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
}

/** Projets du compte, du plus récemment modifié au plus ancien. */
export function getProjects(userId: string | null): Project[] {
  const raw = getSetting<any[]>(userId, PROJECTS_SETTING_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeProject)
    .filter((p): p is Project => p !== null)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export function getProject(userId: string | null, projectIdValue: string | null): Project | null {
  if (!projectIdValue) return null;
  return getProjects(userId).find((p) => p.id === projectIdValue) ?? null;
}

function newProjectId(): string {
  return 'prj_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Crée (sans `id`) ou met à jour un projet. Renvoie le projet enregistré. */
export async function upsertProject(
  input: { id?: string; name: string; description?: string },
  userId: string | null
): Promise<Project> {
  const projects = getProjects(userId);
  const now = Date.now();
  const existing = input.id ? projects.find((p) => p.id === input.id) : undefined;
  const saved: Project = {
    id: existing?.id ?? newProjectId(),
    name: (input.name || '').trim() || 'Projet',
    description: (input.description ?? existing?.description ?? '').trim(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const next = [saved, ...projects.filter((p) => p.id !== saved.id)];
  await setSetting(userId, PROJECTS_SETTING_KEY, next);
  if (userId) window.dispatchEvent(new CustomEvent('projects-updated'));
  return saved;
}

/** Supprime un projet et DÉTACHE ses conversations (elles ne sont pas perdues). */
export async function removeProject(projectIdValue: string, userId: string | null): Promise<void> {
  const next = getProjects(userId).filter((p) => p.id !== projectIdValue);
  await setSetting(userId, PROJECTS_SETTING_KEY, next);

  const map = getChatProjectMap(userId);
  let changed = false;
  const detachedChats: string[] = [];
  for (const chatId of Object.keys(map)) {
    if (map[chatId] === projectIdValue) {
      delete map[chatId];
      detachedChats.push(chatId);
      changed = true;
    }
  }
  if (changed) await setSetting(userId, CHAT_PROJECTS_SETTING_KEY, map);
  // 🗂️ Le centre de données du projet supprimé est REDISTRIBUÉ à chacune de ses
  // conversations : elles redeviennent autonomes sans perdre la mémoire du jeu.
  for (const chatId of detachedChats) {
    mergeScopeMemory(userId, `p:${projectIdValue}`, `c:${chatId}`, true);
  }
  if (detachedChats.length) deleteScopeMemory(userId, `p:${projectIdValue}`);
  if (getActiveProjectId(userId) === projectIdValue) await setActiveProjectId(null, userId);
  if (userId) window.dispatchEvent(new CustomEvent('projects-updated'));
}

// --- Rattachement conversation → projet ---

export function getChatProjectMap(userId: string | null): Record<string, string> {
  const raw = getSetting<Record<string, string>>(userId, CHAT_PROJECTS_SETTING_KEY, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [chatId, projId] of Object.entries(raw)) {
    if (typeof projId === 'string' && projId) out[chatId] = projId;
  }
  return out;
}

export function getProjectIdForChat(chatId: string | null, userId: string | null): string | null {
  if (!chatId) return null;
  return getChatProjectMap(userId)[chatId] ?? null;
}

export function getProjectForChat(chatId: string | null, userId: string | null): Project | null {
  return getProject(userId, getProjectIdForChat(chatId, userId));
}

/** Rattache (ou détache avec `null`) une conversation à un projet. */
export async function setChatProject(
  chatId: string,
  projectIdValue: string | null,
  userId: string | null
): Promise<void> {
  if (!chatId) return;
  const map = getChatProjectMap(userId);
  if (projectIdValue) map[chatId] = projectIdValue;
  else delete map[chatId];
  await setSetting(userId, CHAT_PROJECTS_SETTING_KEY, map);
  // 🗂️ La conversation REJOINT un projet → son centre de données de conversation
  // est FUSIONNÉ dans celui du projet (points importants + journal d'actions),
  // puis son scope est absorbé : plus de doublon, plus de fuite entre projets.
  if (projectIdValue) {
    const moved = mergeConversationHubIntoProject(userId, chatId, projectIdValue);
    if (moved) window.dispatchEvent(new CustomEvent('data-hub-updated'));
  }
  if (userId) window.dispatchEvent(new CustomEvent('projects-updated'));
}

/** Conversations rattachées à un projet (les plus récentes d'abord). */
export function getProjectChats(projectIdValue: string | null, userId: string | null): Chat[] {
  const map = getChatProjectMap(userId);
  return getChats(userId).filter((chat) => map[chat.id] === projectIdValue);
}

/** Conversations sans projet. */
export function getUnassignedChats(userId: string | null): Chat[] {
  const map = getChatProjectMap(userId);
  return getChats(userId).filter((chat) => !map[chat.id]);
}

// --- Projet actif (celui des nouvelles conversations) ---

export function getActiveProjectId(userId: string | null): string | null {
  const value = getSetting<string | null>(userId, ACTIVE_PROJECT_SETTING_KEY, null);
  if (!value) return null;
  // Projet supprimé entre-temps → on nettoie
  return getProjects(userId).some((p) => p.id === value) ? value : null;
}

export async function setActiveProjectId(projectIdValue: string | null, userId: string | null): Promise<void> {
  await setSetting(userId, ACTIVE_PROJECT_SETTING_KEY, projectIdValue ?? null);
  if (userId) window.dispatchEvent(new CustomEvent('projects-updated'));
}

// --- Injection dans le prompt système ---

/**
 * Bloc de prompt système décrivant le projet de la conversation.
 * La description du projet est ainsi « directement dans le système » des
 * conversations qui vivent dans ce dossier.
 */
export function buildProjectPromptSection(project: Project | null): string {
  if (!project) return '';
  const lines: string[] = [
    '[PROJET EN COURS — GD4]',
    `Nom du projet : ${project.name}`,
  ];
  if (project.description) {
    lines.push(
      'Description / consignes du projet (à respecter dans TOUTES les réponses de cette conversation) :',
      project.description
    );
  }
  lines.push(
    'Toutes les conversations de ce dossier appartiennent au MÊME projet : garde cette description en mémoire et reste cohérent avec elle.'
  );
  return `\n\n${lines.join('\n')}`;
}

/** Bloc prêt à concaténer pour une conversation donnée ('' si aucun projet). */
export function buildProjectPromptForChat(chatId: string | null, userId: string | null): string {
  return buildProjectPromptSection(getProjectForChat(chatId, userId));
}

// --- Quota : compteur local PAR COMPTE (pas de synchro multi-appareils volontaire,
//     afin d'éviter les conflits et les contournements. email conservé pour diagnostic.)
export function getQuota(userId: string | null): QuotaState | null {
  try {
    const raw = localStorage.getItem(nsKey(QUOTA_LEGACY_KEY, userId));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed.used === 'number' ? parsed as QuotaState : null;
  } catch {
    return null;
  }
}

export function setQuota(userId: string | null, quota: QuotaState): void {
  try { localStorage.setItem(nsKey(QUOTA_LEGACY_KEY, userId), JSON.stringify(quota)); } catch { /* plein */ }
}

// ============================================================
// MIGRATION ANCIENNES DONNÉES PARTAGÉES → COMPTE
// Une seule fois par appareil, au moment où un compte se connecte :
// l'historique créé hors connexion est rattaché à CE compte.
// ============================================================

function migrateLegacyIntoAccount(userId: string): void {
  if (localStorage.getItem(MIGRATION_FLAG_KEY)) return;
  localStorage.setItem(MIGRATION_FLAG_KEY, '1'); // une seule tentative par appareil

  const legacyChats = parseChats(localStorage.getItem(CHATS_BASE_KEY))
    .map((c) => ({ ...c, updatedAt: c.updatedAt ?? Date.now() }));
  const legacyActiveId = localStorage.getItem(ACTIVE_CHAT_BASE_KEY);
  if (legacyChats.length === 0 && !legacyActiveId) return;

  // Fusion dans le cache du compte (sans écraser ce qui y existe déjà)
  const mine = new Map(getChats(userId).map((c) => [c.id, c]));
  for (const c of legacyChats) if (!mine.has(c.id)) mine.set(c.id, c);

  // Seed du system prompt hérité si le compte n'en a pas encore
  const seed = readSettings(userId);
  if (seed.systemPrompt === undefined) {
    try {
      const legacy = localStorage.getItem(PROMPT_LEGACY_KEY);
      if (legacy) seed.systemPrompt = legacy;
    } catch { /* ignoré */ }
    persistLocalBlob(seed, userId); // écriture locale simple, la synchro suivante poussera
  }

  persistLocalChats(sortChats([...mine.values()]), userId);
  if (legacyActiveId && mine.has(legacyActiveId)) setActiveChatId(legacyActiveId, userId);

  // Poussée cloud best-effort (une future sync repoussera ce qui manque)
  if (legacyChats.length > 0) {
    Promise.resolve(supabase.from('user_chats')
      .upsert(legacyChats.map((c) => chatToRow(c, userId)), { onConflict: 'id' }))
      .then(({ error }) => { if (error) console.warn('[GD4] Migration cloud partielle :', error.message); })
      .catch((e: unknown) => console.warn('[GD4] Migration cloud différée :', e instanceof Error ? e.message : e));
  }

  localStorage.removeItem(CHATS_BASE_KEY);
  localStorage.removeItem(ACTIVE_CHAT_BASE_KEY);
}

/** Écriture locale des préférences sans appel réseau (utilisé par la migration). */
function persistLocalBlob(blob: SettingsBlob, userId: string): void {
  localStorage.setItem(nsKey(SETTINGS_BASE_KEY, userId), JSON.stringify(blob));
}

// ============================================================
// SYNCHRONISATION CLOUD — au démarrage / à chaque connexion
// ============================================================

function rowToChat(row: any): Chat {
  const ts = row?.updated_at ? Date.parse(row.updated_at) : NaN;
  return {
    id: String(row.id),
    title: typeof row.title === 'string' ? row.title : '',
    messages: Array.isArray(row.messages)
      ? row.messages.filter((m: any) => m && typeof m.text === 'string')
      : [],
    updatedAt: Number.isFinite(ts) ? ts : undefined,
  };
}

/** Le plus récent entre local/cloud gagne ; les conversations locales inconnues du cloud sont poussées vers lui. */
async function syncChatsFromCloud(userId: string): Promise<void> {
  let remote: Chat[] = [];
  try {
    const { data, error } = await supabase
      .from('user_chats')
      .select('id, title, messages, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    remote = (data ?? []).map(rowToChat);
  } catch (e: any) {
    console.warn('[GD4] Chargement cloud des conversations impossible :', e?.message || e);
    return; // le cache local du compte est conservé tel quel
  }

  const merged = new Map(remote.map((c) => [c.id, c]));
  const toPush: Chat[] = [];
  for (const local of getChats(userId)) {
    const r = merged.get(local.id);
    if (!r) {
      merged.set(local.id, local);
      toPush.push(local);
    } else if ((local.updatedAt ?? 0) > (r.updatedAt ?? 0)) {
      merged.set(local.id, local);
    }
  }
  persistLocalChats(sortChats([...merged.values()]), userId);

  if (toPush.length > 0) {
    Promise.resolve(supabase.from('user_chats')
      .upsert(toPush.map((c) => chatToRow(c, userId)), { onConflict: 'id' }))
      .then(({ error }) => { if (error) console.warn('[GD4] Poussée local→cloud échouée :', error.message); })
      .catch((e: unknown) => console.warn('[GD4] Poussée local→cloud différée :', e instanceof Error ? e.message : e));
  }

  window.dispatchEvent(new CustomEvent('chats-updated'));
}

/** Fusionne les préférences distantes sous les préférences locales (priorité locale). */
async function loadCloudSettingsIntoCache(userId: string): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('user_settings')
      .select('data')
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data?.data || typeof data.data !== 'object') return;
    const merged = { ...(data.data as SettingsBlob), ...readSettings(userId) };
    persistLocalBlob(merged, userId);
  } catch (e: any) {
    console.warn('[GD4] Chargement des préférences cloud impossible :', e?.message || e);
  }
}

let syncChain: Promise<void> = Promise.resolve();

/**
 * Migration + fusion cloud pour le compte donné.
 * Sérialisé via une chaîne de promesses pour éviter deux fusions concurrentes
 * (INITIAL_SESSION et SIGNED_IN pouvant arriver quasi simultanément).
 */
export function syncAccountData(account: AccountInfo): Promise<void> {
  const run = async () => {
    migrateLegacyIntoAccount(account.id);
    window.dispatchEvent(new CustomEvent('chats-updated')); // l'historique migré s'affiche tout de suite
    await Promise.all([
      loadCloudSettingsIntoCache(account.id),
      syncChatsFromCloud(account.id),
    ]);
    // 🗂️ Centre de données du compte (par projet / conversation) : restauré
    // depuis `user_settings` puis fusionné avec ce qui existe déjà en local.
    await restoreHubFromCloud(account.id);
  };
  syncChain = syncChain.then(run, run);
  return syncChain;
}

// ============================================================
// QUOTA TOKEN — appliqué CÔTÉ SERVEUR par compte
// Tokens INPUT : 18 000  |  Tokens OUTPUT : 7 000
// Réinitialisation toutes les 8 heures (3 fois par jour)
// Code promo : bonus tokens additionnels via promo_codes.json
// ============================================================

export interface TokenQuotaConsumed {
  ok: boolean;
  remainingInput: number;
  remainingOutput: number;
  limitInput: number;
  limitOutput: number;
}

/** État courant du quota TOKEN du compte (pour l'affichage, sans décrémenter). */
export interface TokenQuotaState {
  usedInput: number;
  usedOutput: number;
  limitInput: number;
  limitOutput: number;
  resetAt: string; // ISO 8601
}

/** Décrémente le quota TOKEN côté serveur (RPC consume_token_quota).
    p_input_tokens  : tokens input à consommer
    p_output_tokens : tokens output à consommer (estimation)
    Retourne null si cloud indisponible → repli local. */
export async function consumeTokenQuotaRemote(
  p_input_tokens = 1,
  p_output_tokens = 1,
  windowHours = 8,
  limitInput = 18000,
  limitOutput = 7000,
): Promise<TokenQuotaConsumed | null> {
  try {
    const { data, error } = await supabase.rpc('consume_token_quota', {
      p_input_tokens,
      p_output_tokens,
      p_window_hours: windowHours,
      p_default_input: limitInput,
      p_default_output: limitOutput,
    });
    if (error || !data) return null;
    const d = data as Record<string, unknown>;
    if (d.error === 'not_authenticated') return null;
    return {
      ok: !!d.ok,
      remainingInput: Number(d.remainingInput ?? 0),
      remainingOutput: Number(d.remainingOutput ?? 0),
      limitInput: Number(d.limitInput ?? limitInput),
      limitOutput: Number(d.limitOutput ?? limitOutput),
    };
  } catch (e: any) {
    console.warn('[GD4] Quota token serveur inaccessible, repli local :', e?.message || e);
    return null;
  }
}

/** Retourne l'état courant du quota TOKEN (pour affichage). */
export async function fetchTokenQuotaRemote(userId: string): Promise<TokenQuotaState | null> {
  try {
    const { data, error } = await supabase
      .from('user_token_quotas')
      .select('used_input, used_output, limit_input, limit_output, reset_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) return null;
    return {
      usedInput: Number(data.used_input ?? 0),
      usedOutput: Number(data.used_output ?? 0),
      limitInput: Number(data.limit_input ?? 18000),
      limitOutput: Number(data.limit_output ?? 7000),
      resetAt: data.reset_at,
    };
  } catch {
    return null;
  }
}

// ============================================================
// CODE PROMO — système de bonus tokens via codes promo
// ============================================================

/** Applique un code promo : ajoute les tokens bonus et marque le code comme utilisé. */
export async function applyPromoCode(
  userId: string,
  code: string,
): Promise<{
  ok: boolean;
  newLimitInput: number;
  newLimitOutput: number;
  message: string;
} | null> {
  try {
    // Charger les codes promo depuis le fichier
    const promoData = await loadPromoCodesReadable();
    const entry = promoData.promo_codes[code];

    // 1) Code inexistant
    if (!entry) {
      return {
        ok: false,
        newLimitInput: 0,
        newLimitOutput: 0,
        message: "Ce code promo n'existe pas.",
      };
    }

    // 2) Code expiré
    if (entry.expires_at) {
      const expiry = new Date(entry.expires_at);
      if (expiry <= new Date()) {
        return {
          ok: false,
          newLimitInput: 0,
          newLimitOutput: 0,
          message: "Ce code promo a expiré.",
        };
      }
    }

    // 3) Déjà utilisé par cet utilisateur
    if (entry.used_by && entry.used_by.includes(userId)) {
      return {
        ok: false,
        newLimitInput: 0,
        newLimitOutput: 0,
        message: "Vous avez déjà utilisé ce code promo.",
      };
    }

    // 4) Nombre maximum d'utilisations atteint
    if (entry.max_uses !== undefined && entry.max_uses > 0) {
      const usedCount = entry.used_by ? entry.used_by.length : 0;
      if (usedCount >= entry.max_uses) {
        return {
          ok: false,
          newLimitInput: 0,
          newLimitOutput: 0,
          message: "Ce code promo a atteint son nombre maximum d'utilisations.",
        };
      }
    }

    // 5) Récupérer le quota actuel de l'utilisateur
    const currentQuota = await fetchTokenQuotaRemote(userId);
    const baseInput = currentQuota ? currentQuota.limitInput : 18000;
    const baseOutput = currentQuota ? currentQuota.limitOutput : 7000;

    // 6) Calculer les nouveaux quotas avec bonus
    const bonusInput = entry.increase_input_tokens || 0;
    const bonusOutput = entry.increase_output_tokens || 0;
    const newLimitInput = baseInput + bonusInput;
    const newLimitOutput = baseOutput + bonusOutput;

    // 7) Mettre à jour la table user_token_quotas (augmenter les limites)
    const { error: upsertError } = await supabase
      .from('user_token_quotas')
      .upsert(
        {
          user_id: userId,
          used_input: currentQuota?.usedInput ?? 0,
          used_output: currentQuota?.usedOutput ?? 0,
          limit_input: newLimitInput,
          limit_output: newLimitOutput,
          reset_at: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
        },
        { onConflict: 'user_id' }
      );

    if (upsertError) {
      console.warn('[GD4] Échec de l\'application du code promo en base :', upsertError.message);
      return {
        ok: false,
        newLimitInput: 0,
        newLimitOutput: 0,
        message: "Erreur lors de l'application du code promo. Réessayez.",
      };
    }

    // 8) Enregistrer l'utilisation du code dans user_promo_uses
    const { error: useError } = await supabase
      .from('user_promo_uses')
      .upsert(
        {
          user_id: userId,
          code: code,
          used_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,code' }
      );

    // Si l'erreur est juste une table absente, on continue quand même
    if (useError && !useError.message.includes('does not exist')) {
      console.warn('[GD4] Échec de l\'enregistrement de l\'utilisation du code :', useError.message);
    }

    return {
      ok: true,
      newLimitInput,
      newLimitOutput,
      message: `Code promo appliqué ! Vos quotas sont maintenant de ${newLimitInput.toLocaleString()} tokens input et ${newLimitOutput.toLocaleString()} tokens output par période de 8h.`,
    };
  } catch (e: any) {
    console.warn('[GD4] Erreur lors de l\'application du code promo :', e?.message || e);
    return null;
  }
}

/** Chargement des codes promo depuis le fichier JSON pour vérification côté client (lecture seule). */
async function loadPromoCodesReadable(): Promise<{
  promo_codes: Record<string, {
    description: string;
    increase_input_tokens: number;
    increase_output_tokens: number;
    max_uses: number;
    used_by: string[];
    created_at: string;
    expires_at: string | null;
  }>;
  default_quota: {
    input_tokens: number;
    output_tokens: number;
    reset_window_hours: number;
  };
}> {
  // Récupérer les codes depuis le fichier via l'API serveur
  try {
    const res = await fetch('/api/promo-codes');
    if (res.ok) {
      const data = await res.json();
      return {
        promo_codes: data.promo_codes || {},
        default_quota: data.default_quota || {
          input_tokens: 18000,
          output_tokens: 7000,
          reset_window_hours: 8,
        },
      };
    }
  } catch {
    // Fallback si le fichier n'est pas accessible
  }

  // Valeurs par défaut (si fichier introuvable)
  return {
    promo_codes: {},
    default_quota: {
      input_tokens: 18000,
      output_tokens: 7000,
      reset_window_hours: 8,
    },
  };
}

/** Code aléatoire cryptographique — même format que le relais : GD4-XXXX. */
export function generatePairingCode(): string {
  const bytes = new Uint32Array(4);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
  }
  return 'GD4-' + out;
}

/** Message d'erreur actionable quand la table/cette partie du cloud est absente. */
function pairingErrorHint(e: any): string {
  const msg = String(e?.message || e || '');
  if (/user_pairing_codes|does not exist|schema cache|Could not find the table/i.test(msg)) {
    return '[GD4] Table user_pairing_codes absente → exécutez supabase/migrations/002_quota_pairing.sql dans le SQL Editor Supabase, puis rechargez la page.';
  }
  return `[GD4] Code d'appairage cloud indisponible : ${msg}`;
}

/** Renvoie le code du compte ; le crée (et le stocke en base) s'il n'existe pas encore. */
export async function ensurePairingCode(userId: string, email: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('user_pairing_codes')
      .select('code')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    if (data?.code) return String(data.code);

    const code = generatePairingCode();
    const { error: insErr } = await supabase
      .from('user_pairing_codes')
      .insert({ user_id: userId, code, owner_email: email });
    if (insErr) {
      // Collision sur code unique ou course concurrente → on relit
      const { data: again } = await supabase
        .from('user_pairing_codes')
        .select('code')
        .eq('user_id', userId)
        .maybeSingle();
      return again?.code ?? null;
    }
    return code;
  } catch (e: any) {
    console.warn(pairingErrorHint(e));
    return null;
  }
}

/** Remplace le code du compte par un nouveau (stocké en base, lié à l'email). */
export async function regeneratePairingCode(userId: string, email: string): Promise<string | null> {
  const code = generatePairingCode();
  const ok = await storePairingCode(userId, email, code);
  return ok ? code : null;
}

/** Miroir : enregistre DANS LE COMPTE le code actuellement utilisé par le relais. */
export async function storePairingCode(userId: string, email: string, code: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('user_pairing_codes')
      .upsert(
        { user_id: userId, code, owner_email: email, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' },
      );
    if (error) throw error;
    return true;
  } catch (e: any) {
    console.warn(pairingErrorHint(e));
    return false;
  }
}



