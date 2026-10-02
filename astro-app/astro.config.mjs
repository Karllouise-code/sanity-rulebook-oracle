import { defineConfig } from 'astro/config';
import netlify from '@astrojs/netlify';

// SSR on Netlify's Node runtime so the /api/chat route can run the agent
// loop server-side (Sanity tokens never leave the server).
//
// For the standalone Node LTS server used in the README instead:
//   @astrojs/node => import node from '@astrojs/node'; adapter: node({ mode: 'standalone' })
export default defineConfig({
  output: 'server',
  adapter: netlify(),
});