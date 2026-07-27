/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend address; empty in dev, where Vite proxies /api. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
