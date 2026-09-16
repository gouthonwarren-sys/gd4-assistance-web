// @ts-check
import { defineConfig } from 'astro/config';
import dns from 'node:dns';

// 🔧 IMPORTANT : le réseau local n'a pas d'IPv6 fonctionnelle (les AAAA de
// integrate.api.nvidia.com sont injoignables). Node préfère l'IPv6 par défaut
// → « Failed to fetch » / 502 intermittents vers l'API NVIDIA.
// On force la résolution IPv4 d'abord pour tous les fetch côté serveur.
dns.setDefaultResultOrder('ipv4first');

import tailwindcss from '@tailwindcss/vite';
import netlify from '@astrojs/netlify';

// https://astro.build/config
export default defineConfig({
  // ☁️ MISE EN LIGNE : adapter Netlify — les routes /api/* (groq, nvidia,
  // cloudflare, apply-promo, promo-codes) tournent côté serveur, et les CLÉS
  // du .env restent sur le serveur (jamais exposées au navigateur).
  adapter: netlify(),
  vite: {
    plugins: [tailwindcss()]
  }
});