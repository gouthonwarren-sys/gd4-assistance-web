// ═══════════════════════════════════════════════════════════════════════════
// 🟠 BANDEAU « PROTOTYPE » — ✍️ C'EST ICI QUE TU ÉCRIS TON TEXTE (seul endroit)
// ═══════════════════════════════════════════════════════════════════════════
//
// Ce bandeau orange s'affiche EN HAUT DE L'APP et de la console du plugin
// (http://127.0.0.1:9091/). Il est replié par défaut : un clic l'ouvre.
//
//   • PROTOTYPE_TITLE : la phrase toujours visible quand c'est replié.
//   • PROTOTYPE_TEXT  : le texte détaillé, affiché quand on déplie.
//   • PROTOTYPE_EXTRA : 👉 AJOUTE ICI TES PROPRES PHRASES (une par ligne).
//     Elles sont ajoutées à la fin du bandeau, séparées par une ligne vide.
//
// Pour ajouter une phrase : décommente (enlève les « // ») ou ajoute une ligne :
//     'Ma phrase à moi.',
// Si tu laisses le tableau vide, rien de plus ne s'affiche.
// ═══════════════════════════════════════════════════════════════════════════

export const PROTOTYPE_TITLE = 'Projet en cours de développement (prototype) — clique pour en savoir plus';

/**
 * 🔢 Version du texte du bandeau.
 * Incrémente ce numéro (1 → 2 → 3…) quand tu modifies PROTOTYPE_TEXT : le
 * bandeau RÉAPPARAÎTRA automatiquement chez quelqu'un qui l'avait retiré.
 * Si tu ne changes rien, un utilisateur qui a cliqué ✕ ne le revoit plus.
 */
export const PROTOTYPE_VERSION = '1';

export const PROTOTYPE_TEXT = [
  "GD4 Assistant fonctionne, mais ce n'est pas encore un projet vraiment bien élaboré : c'est un prototype publié tel quel.",
  '',
  '• Le code est encore en chantier : certaines parties sont expérimentales, maladroites ou promises à être réécrites.',
  "• L'IA peut se tromper : une propriété Godot inventée, une action inutile ou un script à revoir. Sauvegarde ton projet avant d'appliquer.",
  '• Les conversations, les projets et le centre de données sont liés à ton compte et synchronisés (cloud) : aucune garantie de conservation à long terme.',
  "• Pas encore d'équipe, de support, ni de documentation complète : les retours et les idées sont bienvenus.",
  '',
  'Merci de tester, et bon développement !',
].join('\n');

/** 👉 AJOUTE ICI TES PHRASES (elles s'affichent à la fin du bandeau). */
export const PROTOTYPE_EXTRA: string[] = [
  // 'Exemple : version bêta 0.9 — écris-moi pour signaler un bug.',
];
