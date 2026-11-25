import {readFileSync} from 'node:fs';
import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'site',
  base: './',
  plugins: [
    react(),
    {
      name: 'project-license',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'LICENSE',
          source: readFileSync(new URL('./LICENSE', import.meta.url), 'utf8'),
        });
      },
    },
  ],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    license: {fileName: 'THIRD_PARTY_LICENSES.md'},
  },
  test: {
    root: '.',
    environment: 'jsdom',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.{js,jsx}'],
  },
});
