// API endpoint pour récupérer les codes promo (public, SANS secrets).
// Ne renvoie que descriptions + default_quota (jamais bonus ni used_by).
import type { APIRoute } from 'astro';
import promoData from '../../lib/promo_codes.json';

export const prerender = false;

export const GET: APIRoute = async () => {
  const codes = (promoData as any)?.promo_codes || {};
  const publicCodes = Object.fromEntries(
    Object.entries(codes).map(([code, v]: [string, any]) => [
      code,
      { description: v?.description || '', expires_at: v?.expires_at ?? null, increase_input_tokens: Number(v?.increase_input_tokens) || 0, increase_output_tokens: Number(v?.increase_output_tokens) || 0 },
    ])
  );
  return new Response(JSON.stringify({
    promo_codes: publicCodes,
    default_quota: (promoData as any)?.default_quota || { input_tokens: 18000, output_tokens: 7000, reset_window_hours: 8 },
  }), { headers: { 'Content-Type': 'application/json' } });
};