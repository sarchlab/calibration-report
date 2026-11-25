import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'site',
  base: './',
  plugins: [react()],
  build: {outDir: '../dist', emptyOutDir: true},
  test: {
    root: '.',
    environment: 'jsdom',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.{js,jsx}'],
  },
});
