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

        const staticDirs = ['vendor', '3d', 'model', 'models'];
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
          'kamyon.png', 'pellegrino.png', 'opencv_js.wasm'
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
