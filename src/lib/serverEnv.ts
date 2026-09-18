// ============================================================
// 🔐 serverEnv — lire les variables d'environnement AU RUNTIME
// ------------------------------------------------------------
// ⚠️ NE JAMAIS écrire `import.meta.env.MA_CLE` dans du code serveur :
// Vite remplace `import.meta.env` (et `import.meta.env.X`) par la VALEUR
// LITTÉRALE au moment du build. Résultat : les clés API se retrouvaient
// écrites EN CLAIR dans le bundle de la fonction Netlify
// (`.netlify/build/entry.mjs`) et dans les chunks `groq/nvidia/cloudflare/
// apply-promo` (+ la SUPABASE_SERVICE_ROLE_KEY). Netlify détecte ces clés,
// affiche « Exposed secrets detected » et BLOQUE le déploiement
// (« Build script returned non-zero exit code: 2 »).
//
// `process.env.NOM` n'est JAMAIS remplacé par Vite : la clé reste sur le
// serveur, injectée par Netlify au démarrage de la fonction.
//
// Ordre de lecture :
//   1) process.env — production Netlify, et `astro build` (Astro y recopie
//      les variables du dashboard / du .env : voir astro/dist/env/
//      vite-plugin-env.js → `process.env[key] = value`).
//   2) repli .env local, en DEV uniquement — `astro dev` ne recopie PAS le
//      fichier .env dans process.env.
// ============================================================
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Accès indirect à `process` : on passe par globalThis pour qu'aucun
 * outil de build (Vite/esbuild `define`) ne puisse remplacer cette
 * expression par une valeur figée à la compilation.
 */
function nodeProcess(): any {
  return (globalThis as any)?.process ?? null;
}

/** Parse minimaliste d'un fichier .env (KEY=VALUE, guillemets optionnels). */
function parseDotEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

let dotEnvCache: Record<string, string> | null = null;

/** Charge (une seule fois) le .env du projet — absent en production. */
function localDotEnv(): Record<string, string> {
  if (dotEnvCache) return dotEnvCache;
  const root = nodeProcess()?.cwd?.() ?? '.';
  const merged: Record<string, string> = {};
  for (const name of ['.env', '.env.local']) {
    try {
      Object.assign(merged, parseDotEnv(readFileSync(join(root, name), 'utf-8')));
    } catch {
      // fichier absent (cas normal en production) : on ignore
    }
  }
  dotEnvCache = merged;
  return merged;
}

/** Valeur de la variable d'environnement `name`, sinon `fallback`. */
export function getEnv(name: string, fallback = ''): string {
  const fromProcess = nodeProcess()?.env?.[name];
  if (typeof fromProcess === 'string' && fromProcess !== '') return fromProcess;
  const fromDotEnv = localDotEnv()[name];
  if (typeof fromDotEnv === 'string' && fromDotEnv !== '') return fromDotEnv;
  return fallback;
}

/** true si la variable est définie (sans jamais révéler sa valeur). */
export function isEnvSet(name: string): boolean {
  return getEnv(name) !== '';
}
