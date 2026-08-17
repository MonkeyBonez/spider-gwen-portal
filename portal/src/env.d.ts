/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Decart API key for local development, read from `portal/.env.local`.
   *
   * Vite **inlines** this into the bundle at build time, so it is a
   * localhost-only convenience — a deployed build must never carry one. Leave
   * it unset and the app falls back to a key entered in the UI and kept in
   * localStorage, which is the path real users take (PRD Phase 2).
   */
  readonly VITE_DECART_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
