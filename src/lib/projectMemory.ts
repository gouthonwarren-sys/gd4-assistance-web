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
  };
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
    return {
      manualContext: typeof parsed.manualContext === 'string' ? parsed.manualContext : '',
      globalSummary: typeof parsed.globalSummary === 'string' ? parsed.globalSummary : '',
      actionLog: Array.isArray(parsed.actionLog) ? parsed.actionLog.filter((entry: any) => typeof entry === 'string') : [],
      modelSummaries: parsed.modelSummaries && typeof parsed.modelSummaries === 'object' ? parsed.modelSummaries : {},
      recentEvents: Array.isArray(parsed.recentEvents) ? parsed.recentEvents.filter((entry: any) => entry && typeof entry.text === 'string') : [],
      lastSummaryAt: typeof parsed.lastSummaryAt === 'number' ? parsed.lastSummaryAt : 0,
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

// Journal cumulatif des actions RÉELLEMENT appliquées dans Godot.
// C'est LA mémoire « ce qui existe déjà dans le jeu » : le modèle peut ainsi
// CONTINUER la création (ne pas recréer Player, ne pas dupliquer les scripts).
const ACTION_LOG_MAX = 150;

export function recordProjectActions(
  userId: string | null,
  modelKey: string,
  actions: any[]
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
  files?: Array<{ path: string; content: string }>
): string {
  const memory = getProjectMemory(userId);
  const selectedModel = modelKey || 'unknown';
  const modelSummary = memory.modelSummaries[selectedModel] || memory.globalSummary;

  const sections: string[] = [];

  if (memory.manualContext) {
    sections.push(`[Contexte manuel du projet]\n${memory.manualContext}`);
  }

  if (modelSummary) {
    sections.push(`[Mémoire de projet (${selectedModel})]\n${modelSummary}`);
  }

  if (memory.globalSummary && !sections.some((section) => section.includes('[Mémoire de projet')) && !modelSummary) {
    sections.push(`[Mémoire globale du projet]\n${memory.globalSummary}`);
  }

  if (memory.actionLog.length) {
    const recentActions = memory.actionLog.slice(-60).join('\n');
    sections.push(`[Journal des actions DÉJÀ appliquées dans Godot — NE REFAIS JAMAIS une action déjà listée ici, ces nœuds/scripts existent déjà dans la scène]\n${recentActions}`);
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
