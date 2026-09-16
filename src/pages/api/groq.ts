// ============================================================
// ⚡ Proxy GROQ (console.groq.com) — côté SERVEUR uniquement
// ------------------------------------------------------------
// Le navigateur ne peut PAS appeler api.groq.com directement
// (CORS → "Failed to fetch"). Ce serveur Astro fait l'appel
// pour lui, avec la clé lue dans .env (jamais exposée au
// navigateur).
//
//   POST /api/groq
//   body: { model: "qwen/qwen3.8-27b", ...payload }  (messages,
//         éventuellement avec image_url pour la vision)
//   → renvoie la réponse JSON Groq (compatible OpenAI) telle quelle.
//
// ⚠️ API compatible OpenAI :
//   POST {BASE_URL}/chat/completions
//   Auth : Bearer <PUBLIC_GROQ_API_KEY>
//   Reponse : { choices: [{ message: { content } }] }
// ============================================================
export const prerender = false;

const API_KEY = import.meta.env.PUBLIC_GROQ_API_KEY || '';
const BASE_URL = import.meta.env.PUBLIC_GROQ_BASE_URL || 'https://api.groq.com/openai/v1';

export async function POST({ request }: { request: Request }) {
  if (!API_KEY) {
    return new Response(
      JSON.stringify({ success: false, errors: [{ message: 'Clé Groq manquante côté serveur : ajoute PUBLIC_GROQ_API_KEY dans .env puis redémarre npm run dev (tu peux la créer gratuitement sur https://console.groq.com → API Keys).' }] }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ success: false, errors: [{ message: 'JSON invalide' }] }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const model = String(body?.model || '').trim();
  if (!model || model.length > 300 || !/^[a-zA-Z0-9._\-\/]{1,300}$/.test(model)) {
    return new Response(JSON.stringify({ success: false, errors: [{ message: 'Nom de modèle Groq manquant ou invalide' }] }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  const payload = { ...body };
  delete payload.model;

  try {
    // Groq peut rejeter ponctuellement une requête (rate limit / réseau).
    // On retente jusqu'à 2 fois avec pause, comme pour NVIDIA.
    let upstream: Response | null = null;
    let lastError: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
      try {
        upstream = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model, ...payload }),
        });
        lastError = null;
        break;
      } catch (e: any) {
        lastError = e;
        upstream = null;
      }
    }
    if (!upstream) {
      throw lastError;
    }
    const text = await upstream.text();
    return new Response(text, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, errors: [{ message: `Serveur GD4 → Groq injoignable : ${error?.message || error}` }] }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}