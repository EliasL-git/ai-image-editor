import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, set VITE_API_PROXY_TARGET to the API origin to proxy /api and asset
// routes through the Vite server (same-origin URLs). When unset, the client
// talks to VITE_API_URL directly.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_PROXY_TARGET ?? '';

  const proxy = apiTarget
    ? {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/api/, ''),
        },
        '/uploads': { target: apiTarget, changeOrigin: true },
        '/masks': { target: apiTarget, changeOrigin: true },
        '/results': { target: apiTarget, changeOrigin: true },
        '/exports': { target: apiTarget, changeOrigin: true },
      }
    : {};

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy,
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
  };
});
