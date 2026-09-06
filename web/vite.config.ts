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
    // Loopback by default: there is no sign-in, so a dev server on the LAN is the
    // person's data on the LAN. Set VITE_HOST=true to reach it from a phone anyway.
    host: process.env.VITE_HOST === 'true' ? true : '127.0.0.1',
    port: 5173,
    // In dev the API is proxied through the same origin, so the app calls /api/...
    // without knowing the backend address - exactly as it does under `npm start`,
    // where the backend serves this build itself.
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
