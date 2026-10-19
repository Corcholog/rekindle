import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'url';
import * as path from 'path';

const root = path.dirname(fileURLToPath(import.meta.url));

// The UI is built to web/dist and served by the API server (same origin, so the request guard
// stays strict). One classic IIFE bundle with fixed names: the tests can load it in jsdom.
export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.join(root, 'src') } },
  build: {
    outDir: path.join(root, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'assets/app.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
