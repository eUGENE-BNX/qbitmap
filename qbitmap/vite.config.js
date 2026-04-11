import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  publicDir: false,

  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
      '/auth': 'http://localhost:3000',
      '/uploads': 'http://localhost:3000',
    }
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: 'hidden',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
        status: resolve(__dirname, 'status.html'),
      },
      external: [
        'three',
        /^three\/addons\//,
      ],
      // [PERF-01] No explicit manualChunks. We tried grouping features into
      // named chunks (`live-broadcast`, `camera-system`, etc.) but Rollup
      // handles cross-chunk shared deps by hoisting them into whichever
      // manual chunk claims them first. That moved services/location-service
      // into the live-broadcast chunk, which then got statically referenced
      // by main (via user-location → LocationService) — the exact leak we
      // were trying to prevent. Letting Rollup auto-split on dynamic import
      // boundaries keeps shared utilities in their own hoisted chunk and
      // the feature chunks cleanly async-only.
    },
    // Copy static assets to dist via a plugin (see below)
  },

  plugins: [
    // Copy non-processed static assets to dist during build
    {
      name: 'copy-static-assets',
      async writeBundle(options) {
        const { cpSync, existsSync } = await import('fs');
        const outDir = options.dir || resolve(__dirname, 'dist');

        // Large dirs (3d, model, videos) are deployed separately via rsync
        const staticDirs = ['vendor', 'modely', 'model3', 'models', 'modelx'];
        for (const dir of staticDirs) {
          const src = resolve(__dirname, dir);
          if (existsSync(src)) {
            cpSync(src, resolve(outDir, dir), { recursive: true });
          }
        }

        // Copy individual static files
        const staticFiles = [
          'favicon.ico', 'logo.png', 'bus.png', 'bus1.png', 'bus2.png',
          'car.png', 'car1.png', 'car2.png', 'car3.png', 'car4.png', 'car5.png',
          'kamyon.png', 'pellegrino.png', 'Caddyfile'
        ];
        for (const file of staticFiles) {
          const src = resolve(__dirname, file);
          if (existsSync(src)) {
            cpSync(src, resolve(outDir, file));
          }
        }
      }
    }
  ]
});
