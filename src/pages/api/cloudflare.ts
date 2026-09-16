// ============================================================
// ☁️ Proxy Cloudflare Workers AI — côté SERVEUR uniquement
// ------------------------------------------------------------
// Le navigateur ne peut PAS appeler api.cloudflare.com directement
// (CORS refusé → "Failed to fetch"). Ce serveur Astro fait l'appel
// pour lui, avec la clé lue dans .env (jamais exposée au navigateur).
//
//   POST /api/cloudflare
//   body: { model: "@cf/...", ...payload }   (messages OU prompt+image)
//   → renvoie la réponse JSON de Cloudflare telle quelle.
// ============================================================
export const prerender = false;

const ACCOUNT_ID = import.meta.env.PUBLIC_CLOUDFLARE_ACCOUNT_ID || '';
const API_KEY = import.meta.env.PUBLIC_CLOUDFLARE_API_KEY || '';

export async function POST({ request }: { request: Request }) {
  if (!API_KEY || !ACCOUNT_ID) {
    return new Response(
      JSON.stringify({ success: false, errors: [{ message: 'Clé Cloudflare manquante côté serveur : ajoute PUBLIC_CLOUDFLARE_API_KEY et PUBLIC_CLOUDFLARE_ACCOUNT_ID dans .env puis redémarre npm run dev.' }] }),
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
  if (!model || model.length > 200 || !/^[@a-zA-Z0-9._\-\/]+$/.test(model)) {
    return new Response(JSON.stringify({ success: false, errors: [{ message: 'Nom de modèle manquant ou invalide' }] }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  const payload = { ...body };
  delete payload.model;

  try {
    const upstream = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${model}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    );
    const text = await upstream.text();
    return new Response(text, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, errors: [{ message: `Serveur GD4 → Cloudflare injoignable : ${error?.message || error}` }] }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
