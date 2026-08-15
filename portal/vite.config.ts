import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        // Side-by-side transition comparison, driven by the real transition
        // module rather than a copy of it (PRD §4.1).
        transitions: resolve(__dirname, 'transitions.html'),
      },
    },
  },
});
