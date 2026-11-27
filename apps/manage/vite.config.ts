import { defineConfig, type Plugin } from 'vite';
import { moduleContentSecurityPolicy } from './src/features/modules/security';
import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
// The explicit local smoke mode mirrors Worker CSP with fixed loopback artifact origin.
const smokeCsp: Plugin = {
  name: 'rod-module-smoke-csp',
  configurePreviewServer(server) {
    server.middlewares.use((_request, response, next) => {
      response.setHeader(
        'Content-Security-Policy',
        moduleContentSecurityPolicy(true).replaceAll('https://sandbox.migos.club', 'http://localhost:4173'),
      );
      next();
    });
  },
};
export default defineConfig(({ mode }) => ({
  plugins: [
    ...(mode === 'federation-smoke' ? [smokeCsp] : []),
    react(),
    tailwindcss(),
    federation({
      name: 'rod_manage',
      shared: {
        react: { singleton: true, requiredVersion: '^19.2.4', strictVersion: true },
        'react-dom': { singleton: true, requiredVersion: '^19.2.4', strictVersion: true },
      },
      dts: false,
    }),
  ],
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 4096 },
  server: {
    port: 5174,
    host: '0.0.0.0',
    proxy: {
      '/api': { target: 'http://127.0.0.1:8788', changeOrigin: true },
    },
  },
}));
