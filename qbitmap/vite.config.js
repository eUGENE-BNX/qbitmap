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
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
        status: resolve(__dirname, 'status.html'),
      },
      external: [
        'three',
        /^three\/addons\//,
      ]
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
        const staticDirs = ['vendor', 'models'];
        for (const dir of staticDirs) {
          const src = resolve(__dirname, dir);
          if (existsSync(src)) {
            cpSync(src, resolve(outDir, dir), { recursive: true });
          }
        }

        // Copy JS non-module assets (faceplugin, wasm, etc.)
        const jsNonModuleDirs = ['js/faceplugin'];
        for (const dir of jsNonModuleDirs) {
          const src = resolve(__dirname, dir);
          if (existsSync(src)) {
            cpSync(src, resolve(outDir, dir), { recursive: true });
          }
        }
        const jsNonModuleFiles = [
          'js/faceplugin.bundle.js', 'js/faceplugin.bundle.js.LICENSE.txt',
          'js/3e1194e05c0d74968f65.mjs', 'js/3e1194e05c0d74968f65.mjs.LICENSE.txt',
          'js/9b38a8c18d5f4d131491.wasm', 'js/liveness-detector.js'
        ];
        for (const file of jsNonModuleFiles) {
          const src = resolve(__dirname, file);
          if (existsSync(src)) {
            const { mkdirSync } = await import('fs');
            mkdirSync(resolve(outDir, 'js'), { recursive: true });
            cpSync(src, resolve(outDir, file));
          }
        }

        // Copy individual static files
        const staticFiles = [
          'favicon.ico', 'logo.png', 'bus.png', 'bus1.png', 'bus2.png',
          'car.png', 'car1.png', 'car2.png', 'car3.png', 'car4.png', 'car5.png',
          'kamyon.png', 'pellegrino.png', 'opencv_js.wasm', 'Caddyfile'
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
