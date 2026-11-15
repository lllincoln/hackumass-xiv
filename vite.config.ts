import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS=1 npm run dev  → self-signed HTTPS so phones on the LAN can use sensors.
const https = process.env.HTTPS === '1';
// HMR=0 (npm run dev:phone) → no hot-reload socket. Vite's client reloads the whole page whenever that socket drops
// (it assumes the dev server restarted), and tunnels drop idle sockets: through a tunnel the app reset every few
// seconds. Without HMR, refresh by hand after code changes.
const hmr = process.env.HMR !== '0';

export default defineConfig({
  plugins: [react(), ...(https ? [basicSsl()] : [])],
  server: {
    port: 5173,
    allowedHosts: true,
    // `ws: false` (not just `hmr: false`, which still opens the socket) so there is nothing to drop.
    ...(hmr ? {} : { hmr: false, ws: false }),
    proxy: { '/api': 'http://localhost:8787' },
  },
  preview: {
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2500,
  },
  test: {
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
    environment: 'node',
  },
});

