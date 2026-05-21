import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

/**
 * Vite config pro dashboard Svelte. Source: `frontend/`. Build: `frontend/dist/`.
 *
 * Em dev: rodar `npm run dev:frontend` em :5173 com proxy /api e /login pro
 * Fastify em :PORT (default 3000, daemon).
 *
 * Em prod: `npm run build` gera `frontend/dist/`, e o Fastify serve via
 * @fastify/static. Daemon = único processo no Railway.
 */
export default defineConfig({
  root: 'frontend',
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/login': 'http://localhost:3000',
      '/logout': 'http://localhost:3000',
    },
  },
});
