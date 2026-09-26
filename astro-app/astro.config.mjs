import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

// SSR on a Node adapter so the /api/chat route can run the agent loop
// server-side (Sanity tokens never leave the server).
//
// Deploying to Vercel or Netlify? Swap the adapter:
//   @astrojs/vercel => import vercel from '@astrojs/vercel'; adapter: vercel()
//   @astrojs/netlify => import netlify from '@astrojs/netlify'; adapter: netlify()
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
});