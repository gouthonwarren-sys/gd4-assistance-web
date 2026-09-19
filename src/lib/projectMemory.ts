// ---------------------------------------------------------------------
// Mémoire de projet globale par compte + modèle IA.
// Objectif : garder un contexte durable du projet, même quand le chat
// dépasse le contexte du modèle. On réinjecte au bon moment un résumé
// synthétique du travail déjà accompli.
// ---------------------------------------------------------------------

export interface ProjectMemoryEvent {
  role: 'user' | 'assistant';
  text: string;
  modelKey: string;
  createdAt: number;
}

export interface ProjectContextMemory {
  manualContext: string;
  globalSummary: string;
  actionLog: string[];              // journal cumulatif des actions Godot appliquées
  modelSummaries: Record<string, string>;
  recentEvents: ProjectMemoryEvent[];
  lastSummaryAt: number;
  scopes: Record<string, ScopeMemory>;  // 🆕 mémoire PAR projet / conversation
}

/**
 * 🗂️ Mémoire d'un SCOPE (un projet, ou une conversation isolée).
 * - `facts`     : centre de données (points importants décidés avec l'IA)
 * - `actionLog` : journal des actions RÉELLEMENT appliquées dans ce scope
 *   (recadré : les actions d'un projet de jeu ne polluent plus un autre projet)
 * Clés de scope : `p:<projectId>` | `c:<chatId>` | `global`
 */
export interface ScopeMemory {
  facts: string[];
  actionLog: string[];
  updatedAt: number;
}

/** Clé de scope : le projet s'il existe, sinon la conversation elle-même. */
export function memoryScopeKey(chatId: string | null, projectId: string | null): string {
  if (projectId) return `p:${projectId}`;
  if (chatId) return `c:${chatId}`;
  return 'global';
}

export function scopeLabel(scopeKey: string, projectName?: string, chatTitle?: string): string {
  if (scopeKey.startsWith('p:')) return projectName ? `projet « ${projectName} »` : 'projet';
  if (scopeKey.startsWith('c:')) return chatTitle ? `conversation « ${chatTitle} »` : 'cette conversation';
  return 'mémoire globale';
}

const PROJECT_CONTEXT_KEY = 'gd4_project_context_memory';

function nsKey(baseKey: string, userId: string | null): string {
  return userId ? `${baseKey}::u:${userId}` : baseKey;
}

function makeDefaultMemory(): ProjectContextMemory {
  return {
    manualContext: '',
    globalSummary: '',
    actionLog: [],
    modelSummaries: {},
    recentEvents: [],
    lastSummaryAt: 0,
    scopes: {},
  };
}

function makeDefaultScope(): ScopeMemory {
  return { facts: [], actionLog: [], updatedAt: Date.now() };
}

function normalizeText(value: string, preserveLineBreaks = false): string {
  const base = (value || '').replace(/\r/g, '');
  if (preserveLineBreaks) {
    return base
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return base.replace(/\s+/g, ' ').trim();
}

function summarizeEvents(events: ProjectMemoryEvent[]): string {
  const text = events
    .map((event) => `${event.role === 'user' ? 'Utilisateur' : 'Assistant'} (${event.modelKey}) : ${event.text}`)
    .join('\n');
  const clean = normalizeText(text);
  if (!clean) return '';
  return clean.length > 1800 ? `${clean.slice(0, 1800).trim()}…` : clean;
}

export function getProjectMemory(userId: string | null): ProjectContextMemory {
  try {
    const raw = localStorage.getItem(nsKey(PROJECT_CONTEXT_KEY, userId));
    if (!raw) return makeDefaultMemory();
    const parsed = JSON.parse(raw);
    const scopes: Record<string, ScopeMemory> = {};
    if (parsed.scopes && typeof parsed.scopes === 'object') {
      for (const [key, value] of Object.entries(parsed.scopes as any)) {
        if (!value || typeof value !== 'object') continue;
        scopes[key] = {
          facts: Array.isArray((value as any).facts)
            ? (value as any).facts.filter((f: any) => typeof f === 'string' && f.trim())
            : [],
          actionLog: Array.isArray((value as any).actionLog)
            ? (value as any).actionLog.filter((a: any) => typeof a === 'string')
            : [],
          updatedAt: typeof (value as any).updatedAt === 'number' ? (value as any).updatedAt : Date.now(),
        };
      }
    }
    return {
      manualContext: typeof parsed.manualContext === 'string' ? parsed.manualContext : '',
      globalSummary: typeof parsed.globalSummary === 'string' ? parsed.globalSummary : '',
      actionLog: Array.isArray(parsed.actionLog) ? parsed.actionLog.filter((entry: any) => typeof entry === 'string') : [],
      modelSummaries: parsed.modelSummaries && typeof parsed.modelSummaries === 'object' ? parsed.modelSummaries : {},
      recentEvents: Array.isArray(parsed.recentEvents) ? parsed.recentEvents.filter((entry: any) => entry && typeof entry.text === 'string') : [],
      lastSummaryAt: typeof parsed.lastSummaryAt === 'number' ? parsed.lastSummaryAt : 0,
      scopes,
    };
  } catch {
    return makeDefaultMemory();
  }
}

function saveProjectMemory(userId: string | null, memory: ProjectContextMemory): void {
  try {
    localStorage.setItem(nsKey(PROJECT_CONTEXT_KEY, userId), JSON.stringify(memory));
  } catch {
    // stockage indisponible → on ignore sans casser le reste
  }
}

export function getManualProjectContext(userId: string | null): string {
  return getProjectMemory(userId).manualContext || '';
}

export function setManualProjectContext(userId: string | null, value: string): void {
  const memory = getProjectMemory(userId);
  memory.manualContext = normalizeText(value, true);
  saveProjectMemory(userId, memory);
}

export function recordProjectConversation(
  userId: string | null,
  event: { role: 'user' | 'assistant'; text: string; modelKey: string }
): void {
  if (!event || !event.text || !event.text.trim()) return;

  const memory = getProjectMemory(userId);
  memory.recentEvents.push({
    role: event.role,
    text: normalizeText(event.text),
    modelKey: event.modelKey || 'unknown',
    createdAt: Date.now(),
  });

  // Fenêtre VERBATIM large : on garde 30 échanges intégraux. Quand la fenêtre
  // déborde, les échanges sortants sont ACCUMULÉS dans le résumé global
  // (l'ancien résumé n'est plus remplacé → le modèle n'oublie plus le début
  // de la conversation, il peut continuer la création du jeu sur la durée).
  const MAX_EVENTS = 30;
  const SUMMARY_MAX_CHARS = 3000;
  if (memory.recentEvents.length > MAX_EVENTS) {
    const overflow = memory.recentEvents.slice(0, memory.recentEvents.length - MAX_EVENTS);
    const incoming = summarizeEvents(overflow);
    const combined = [memory.globalSummary, incoming].filter(Boolean).join('\n');
    memory.globalSummary = combined.length > SUMMARY_MAX_CHARS
      ? combined.slice(combined.length - SUMMARY_MAX_CHARS).trim()
      : combined;
    const modelKey = memory.recentEvents[memory.recentEvents.length - 1]?.modelKey || 'unknown';
    memory.modelSummaries[modelKey] = memory.globalSummary;
    memory.recentEvents = memory.recentEvents.slice(-MAX_EVENTS);
    memory.lastSummaryAt = Date.now();
  }

  saveProjectMemory(userId, memory);
}

// ============================================================
// 🗂️ CENTRE DE DONNÉES (hub) + JOURNAL RECADRÉ, PAR SCOPE
// ------------------------------------------------------------
// Chaque projet (ou conversation isolée) possède son propre scope :
//   - ses FAITS importants (centre de données)
//   - son JOURNAL des actions réellement appliquées
// → les actions d'un projet de jeu ne polluent plus un autre projet,
//   et le journal garde toute sa puissance DANS son périmètre.
// ============================================================

const HUB_FACT_MAX = 80;
const HUB_FACT_LEN_MAX = 400;

/** Scope d'un chat : `p:<projet>` s'il appartient à un projet, sinon `c:<chat>`. */
export function getScopeMemory(userId: string | null, scopeKey: string): ScopeMemory {
  const memory = getProjectMemory(userId);
  if (!memory.scopes[scopeKey]) {
    return makeDefaultScope();
  }
  return memory.scopes[scopeKey];
}

function updateScope(
  userId: string | null,
  scopeKey: string,
  updater: (scope: ScopeMemory) => void
): ScopeMemory {
  const memory = getProjectMemory(userId);
  const scope = memory.scopes[scopeKey] ?? makeDefaultScope();
  updater(scope);
  scope.updatedAt = Date.now();
  memory.scopes[scopeKey] = scope;
  saveProjectMemory(userId, memory);
  try { window.dispatchEvent(new CustomEvent('memory-updated', { detail: { scope: scopeKey } })); } catch { /* ignore */ }
  return scope;
}

/** 📌 Ajoute un point important au centre de données du scope (dédupliqué). */
export function addHubFact(userId: string | null, scopeKey: string, text: string): boolean {
  const clean = normalizeText(text || '');
  if (!clean) return false;
  const trimmed = clean.length > HUB_FACT_LEN_MAX ? `${clean.slice(0, HUB_FACT_LEN_MAX).trim()}…` : clean;
  let added = false;
  updateScope(userId, scopeKey, (scope) => {
    const exists = scope.facts.some((f) => f.toLowerCase() === trimmed.toLowerCase());
    if (exists) return;
    scope.facts.push(trimmed);
    if (scope.facts.length > HUB_FACT_MAX) scope.facts = scope.facts.slice(-HUB_FACT_MAX);
    added = true;
  });
  return added;
}

/** 🗑 Retire un point du centre de données (par index). */
export function removeHubFact(userId: string | null, scopeKey: string, index: number): void {
  updateScope(userId, scopeKey, (scope) => {
    if (index >= 0 && index < scope.facts.length) scope.facts.splice(index, 1);
  });
}

export function getHubFacts(userId: string | null, scopeKey: string): string[] {
  return [...getScopeMemory(userId, scopeKey).facts];
}

export function clearScopeMemory(userId: string | null, scopeKey: string): void {
  updateScope(userId, scopeKey, (scope) => {
    scope.facts = [];
    scope.actionLog = [];
  });
}

// Journal cumulatif des actions RÉELLEMENT appliquées dans Godot.
// C'est LA mémoire « ce qui existe déjà dans le jeu » : le modèle peut ainsi
// CONTINUER la création (ne pas recréer Player, ne pas dupliquer les scripts).
const ACTION_LOG_MAX = 150;
const SCOPED_ACTION_LOG_MAX = 120;

export function recordProjectActions(
  userId: string | null,
  modelKey: string,
  actions: any[],
  scopeKey?: string
): void {
  void modelKey;
  if (!Array.isArray(actions) || !actions.length) return;
  const memory = getProjectMemory(userId);
  const stamp = new Date().toISOString().slice(5, 16).replace('T', ' ');
  const lines: string[] = [];
  for (const a of actions.slice(0, 30)) {
    if (!a || typeof a !== 'object') continue;
    const type = String((a as any).type || '').trim();
    if (!type) continue;
    switch (type) {
      case 'create_node':
        lines.push(`create_node ${String((a as any).node_type || '?')} "${String((a as any).name || '?')}" sous "${String((a as any).parent || '/')}"`);
        break;
      case 'create_script': {
        const code = String((a as any).code || '');
        const extendsLine = code.split('\n').map((l) => l.trim()).find((l) => l.startsWith('extends')) || '';
        lines.push(`create_script sur "${String((a as any).node || (a as any).name || '?')}" (${code.split('\n').length} lignes${extendsLine ? `, ${extendsLine}` : ''})`);
        break;
      }
      case 'set_property':
        lines.push(`set_property "${String((a as any).node || '?')}" → ${(a as any).property || '?'} = ${JSON.stringify((a as any).value ?? null).slice(0, 80)}`);
        break;
      case 'connect_signal':
        lines.push(`connect_signal "${String((a as any).from_node || '?')}" → "${String((a as any).to_node || '?')}" (méthode ${String((a as any).method || '?')})`);
        break;
      case 'delete_node':
        lines.push(`delete_node "${String((a as any).name || (a as any).node || '?')}"`);
        break;
      default:
        lines.push(`${type} ${JSON.stringify(a).slice(0, 120)}`);
    }
  }
  if (!lines.length) return;

  // 📓 JOURNAL RECADRÉ : les actions vont dans le scope (projet/conversation)
  // pour ne plus mélanger deux projets de jeu différents. Le journal global
  // historique reste alimenté en parallèle (aucune perte d'efficacité).
  if (scopeKey) {
    const scope = memory.scopes[scopeKey] ?? makeDefaultScope();
    for (const line of lines) scope.actionLog.push(`${stamp} — ${line}`);
    const dedupedScoped: string[] = [];
    for (const entry of scope.actionLog) {
      if (dedupedScoped.length && dedupedScoped[dedupedScoped.length - 1] === entry) continue;
      dedupedScoped.push(entry);
    }
    scope.actionLog = dedupedScoped.slice(-SCOPED_ACTION_LOG_MAX);
    scope.updatedAt = Date.now();
    memory.scopes[scopeKey] = scope;
  }

  for (const line of lines) memory.actionLog.push(`${stamp} — ${line}`);
  // Cap du journal (on garde les plus récentes) + dédup des doublons consécutifs
  const deduped: string[] = [];
  for (const entry of memory.actionLog) {
    if (deduped.length && deduped[deduped.length - 1] === entry) continue;
    deduped.push(entry);
  }
  memory.actionLog = deduped.slice(-ACTION_LOG_MAX);
  saveProjectMemory(userId, memory);
}

export function buildInjectedProjectContext(
  userId: string | null,
  modelKey: string,
  files?: Array<{ path: string; content: string }>,
  options?: { scopeKey?: string; scopeLabel?: string }
): string {
  const memory = getProjectMemory(userId);
  const selectedModel = modelKey || 'unknown';
  const modelSummary = memory.modelSummaries[selectedModel] || memory.globalSummary;
  const scopeKey = options?.scopeKey || '';
  const label = options?.scopeLabel || (scopeKey.startsWith('p:') ? 'ce projet' : 'cette conversation');
  const scope = scopeKey ? (memory.scopes[scopeKey] ?? makeDefaultScope()) : null;

  const sections: string[] = [];

  if (memory.manualContext) {
    sections.push(`[Contexte manuel du projet]\n${memory.manualContext}`);
  }

  // 🗂️ CENTRE DE DONNÉES du scope : les points importants décidés avec l'IA
  if (scope && scope.facts.length) {
    sections.push(
      `[CENTRE DE DONNÉES — ${label} (points importants déjà actés, à respecter)]\n` +
      scope.facts.map((f) => `• ${f}`).join('\n')
    );
  }

  if (modelSummary) {
    sections.push(`[Mémoire de projet (${selectedModel})]\n${modelSummary}`);
  }

  if (memory.globalSummary && !sections.some((section) => section.includes('[Mémoire de projet')) && !modelSummary) {
    sections.push(`[Mémoire globale du projet]\n${memory.globalSummary}`);
  }

  // 📓 JOURNAL DES ACTIONS — recadré sur le scope courant (projet/conversation).
  // Le journal reste COMPLET et consultable dans l'app (bouton 📜 Journal) : il
  // n'est simplement plus injecté d'un projet de jeu vers un autre.
  const scopedLog = scope?.actionLog ?? [];
  if (scopedLog.length) {
    sections.push(
      `[Journal des actions DÉJÀ appliquées dans ${label} — NE REFAIS JAMAIS une action déjà listée ici, ces nœuds/scripts existent déjà dans la scène]\n` +
      scopedLog.slice(-60).join('\n')
    );
  }

  // Filet de sécurité (aucune perte d'efficacité) : si le journal du dossier est
  // encore court, on rappelle les actions des CONVERSATIONS libres — JAMAIS
  // celles d'un AUTRE PROJET (deux jeux ne se mélangent plus). Ces lignes servent
  // seulement de garde-fou « ne recrée pas un nœud qui existe déjà ».
  if (scopedLog.length < 12) {
    const otherChatsLog: string[] = [];
    for (const [key, value] of Object.entries(memory.scopes)) {
      if (key === scopeKey || key.startsWith('p:')) continue;
      for (const entry of value.actionLog.slice(-10)) {
        if (!otherChatsLog.includes(entry)) otherChatsLog.push(entry);
      }
    }
    if (otherChatsLog.length) {
      sections.push(
        `[Journal d'autres CONVERSATIONS libres (AUCUN autre projet n'est mélangé ici — À VÉRIFIER avant de recréer un nœud ou un script, mais NE L'APPLIQUER À ${label} QUE sur confirmation)]\n` +
        otherChatsLog.slice(-20).join('\n')
      );
    }
  }

  if (files && files.length) {
    const filesText = files
      .slice(0, 18)
      .map((file) => `\n--- ${file.path} ---\n${file.content}`)
      .join('');
    sections.push(`[Fichiers de projet actuellement disponibles]\n${filesText}`);
  }

  if (!sections.length) return '';

  return `\n\n[CONTEXT PROJECT MEMORY — GD4]\n${sections.join('\n\n')}`;
}
