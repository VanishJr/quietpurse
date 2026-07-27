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
  },
});
