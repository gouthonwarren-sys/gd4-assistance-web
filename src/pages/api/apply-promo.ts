// POST /api/apply-promo — Body: { "code": "CODE", "userId": "uuid" }
// La VRAIE logique est ici côté SERVEUR (jamais dans le navigateur).
import type { APIRoute } from 'astro';
import promoData from '../../lib/promo_codes.json';
import { createClient } from '@supabase/supabase-js';

export const prerender = false;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json().catch(() => ({}));
    const code = String(body?.code || '').trim().toUpperCase();
    const userId = String(body?.userId || '').trim();
    if (!code || !userId) return json({ ok: false, message: 'Code et userId requis.' }, 400);
    // L'utilisateur DOIT être connecté avec un vrai compte Supabase (UUID) :
    // les ids locaux (sessions anonymes) casseraient la clé étrangère vers
    // auth.users → message clair au lieu d'une erreur 500 obscure.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(userId)) {
      return json({ ok: false, message: 'Connecte-toi avec un compte (Google/email) pour utiliser un code promo — il ne s\'applique pas aux sessions locales.' }, 400);
    }

    // 1) Vérifie le code dans promo_codes.json (serveur uniquement)
    const codes = (promoData as any)?.promo_codes || {};
    const promo = codes[code];
    if (!promo) return json({ ok: false, message: 'Code promo invalide.' }, 404);
    if (promo.expires_at && new Date(promo.expires_at).getTime() < Date.now()) {
      return json({ ok: false, message: 'Ce code promo a expiré.' }, 410);
    }
    const usedBy: string[] = Array.isArray(promo.used_by) ? promo.used_by : [];
    if (usedBy.includes(userId)) return json({ ok: false, message: 'Tu as déjà utilisé ce code.' }, 409);

    // 2) Clés SERVEUR (SANS préfixe PUBLIC → jamais exposées au navigateur)
    const url = (import.meta as any).env?.SUPABASE_URL
      || (typeof process !== 'undefined' ? (process as any)?.env?.SUPABASE_URL : '')
      || 'https://loovbsraccdgofmakyqq.supabase.co';
    const serviceKey = (import.meta as any).env?.SUPABASE_SERVICE_ROLE_KEY
      || (typeof process !== 'undefined' ? (process as any)?.env?.SUPABASE_SERVICE_ROLE_KEY : '')
      || '';
    if (!url || !serviceKey) {
      return json({
        ok: false,
        message: 'Code valide mais serveur non configuré : ajoute SUPABASE_SERVICE_ROLE_KEY dans .env puis redémarre, et exécute supabase/migrations/003_token_quota_promo.sql dans Supabase.',
      }, 500);
    }
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const bonusInput = Number(promo.increase_input_tokens || 0);
    const bonusOutput = Number(promo.increase_output_tokens || 0);

    // 3) Bonus atomique via RPC (exécute 003_token_quota_promo.sql d'abord)
    const { data, error } = await admin.rpc('apply_promo_bonus', {
      p_user: userId,
      p_code: code,
      p_bonus_input: bonusInput,
      p_bonus_output: bonusOutput,
      p_max_uses: Number(promo.max_uses ?? 1),
    });
    if (error) {
      const msg = String((error as any)?.message || error);
      if (/apply_promo_bonus|does not exist|schema cache|Could not find/i.test(msg)) {
        return json({
          ok: false,
          message: 'Serveur incomplet : exécute supabase/migrations/003_token_quota_promo.sql dans le SQL Editor Supabase, puis réessaie.',
        }, 500);
      }
      return json({ ok: false, message: 'Erreur serveur : ' + msg }, 500);
    }
    const row: any = Array.isArray(data) ? data[0] : data;
    if (!row?.ok) {
      const reason = String(row?.error || 'refusé');
      if (reason === 'already_used') return json({ ok: false, message: 'Tu as déjà utilisé ce code.' }, 409);
      if (reason === 'max_uses_reached') return json({ ok: false, message: 'Ce code a atteint son max d’utilisations.' }, 409);
      return json({ ok: false, message: 'Code refusé.' }, 400);
    }
    return json({
      ok: true,
      newLimitInput: row.limit_input,
      newLimitOutput: row.limit_output,
      message: `Code ${code} appliqué ! Nouveau quota : ${Number(row.limit_input).toLocaleString('fr-FR')} in · ${Number(row.limit_output).toLocaleString('fr-FR')} out (8h).`,
    });
  } catch (e: any) {
    return json({ ok: false, message: e?.message || 'Erreur inconnue.' }, 500);
  }
};