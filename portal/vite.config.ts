import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const here = import.meta.dirname;

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
        // Side-by-side transition comparison, driven by the real transition
        // module rather than a copy of it (PRD §4.1).
        transitions: resolve(here, 'transitions.html'),
        // Close-detection strictness ladder, driven by the real geometry
        // module rather than a copy of it (PRD §2.2.1).
        closure: resolve(here, 'closure.html'),
        // Same comparison as `closure`, but on the live camera — the strictness
        // gets picked here, on real hands.
        tune: resolve(here, 'tune.html'),
      },
    },
  },
});
