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

export const PROTOTYPE_TITLE = "Projet en cours de développement (prototype) — gratuit pour l'instant, cliquez pour en savoir plus";

/**
 * 🔢 Version du texte du bandeau.
 * Incrémente ce numéro (1 → 2 → 3…) quand tu modifies PROTOTYPE_TEXT : le
 * bandeau RÉAPPARAÎTRA automatiquement chez quelqu'un qui l'avait retiré.
 * Si tu ne changes rien, un utilisateur qui a cliqué ✕ ne le revoit plus.
 */
export const PROTOTYPE_VERSION = '2';

export const PROTOTYPE_TEXT = [
  "GD4 Assistant fonctionne, mais ce n'est pas encore un projet vraiment bien élaboré : c'est un prototype publié tel quel.",
  '',
  '• Le code est encore en chantier : certaines parties sont expérimentales, maladroites ou promises à être réécrites.',
  "• L'IA peut se tromper : une propriété Godot inventée, une action inutile ou un script à revoir. Sauvegardez votre projet avant d'appliquer.",
  '• Les conversations, les projets et le centre de données sont liés à votre compte et synchronisés (cloud) : aucune garantie de conservation à long terme.',
  "• Pas encore d'équipe, de support, ni de documentation complète : les retours et les idées sont bienvenus.",
  '',
  "🚧 C'est gratuit pour le moment — et c'est voulu : le produit n'est pas terminé. Vous utilisez une version préliminaire : attendez-vous à des limitations (file d'attente aux heures de pointe, quotas journaliers) et à quelques bugs occasionnels.",
  '',
  'À venir avec la Phase 2 (très prochainement) :',
  "🧠 Modèles d'IA optimisés spécifiquement pour Godot : scripts, architecture du projet, shaders.",
  "⚡ Des réponses plus rapides et plus fiables — sans file d'attente.",
  '💳 Des abonnements pour ceux qui ont besoin de plus.',
  '',
  "Les 25 premiers inscrits bénéficient d'un accès gratuit à vie. Vous êtes parmi les premiers : c'est votre avantage.",
  '',
  "Vous avez trouvé un bug ? Une réponse étrange ? Dites-le-nous, c'est justement à ça que sert cette phase. → [Discord]",
].join('\n');

/** 👉 AJOUTE ICI TES PHRASES (elles s'affichent à la fin du bandeau). */
export const PROTOTYPE_EXTRA: string[] = [
  "💙 Merci d'être parmi les premiers à tester GD4 Assistant : chaque bug signalé, chaque idée partagée construit la version finale.",
  "Merci pour votre patience et votre confiance — et bon développement ! 🚀",
];