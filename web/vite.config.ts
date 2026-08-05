import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Where the dev server forwards /api. This is resolved on the machine running
 * Vite, so it stays 'localhost' even when the browser is on another device —
 * deliberately NOT VITE_API_URL, which is a client-side address.
 */
const BACKEND = process.env.BACKEND_URL || 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    // Loopback by default. The bundle no longer carries any secret (access is a
    // cookie session), so exposing the dev server on the LAN is now merely a dev
    // convenience question — set VITE_HOST=true to reach it from a phone.
    host: process.env.VITE_HOST === 'true' ? true : '127.0.0.1',
    port: 5173,
    // In dev the API is proxied through the same origin: no CORS, and the app can
    // call /api/... without knowing the backend address. In a production build the
    // address comes from VITE_API_URL (see src/api.ts).
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    /**
     * Two pages, not one. `index.html` is the app; `landing.html` is the public
     * page "Back to Website" points at, and it shares nothing with the app but the
     * font and the palette — no session, no /api call, no bundle in common.
     *
     * A real deployment probably wants the landing at `/` and the app at `/app`.
     * That is a routing decision about where the product lives, and it belongs to
     * whoever deploys it; keeping the app's own URL where it has always been is
     * what makes this change nothing but an addition.
     */
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'index.html'),
        landing: resolve(__dirname, 'landing.html'),
      },
    },
  },
});
