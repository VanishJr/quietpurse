/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend address; empty in dev, where Vite proxies /api. */
  readonly VITE_API_URL?: string;
  /** Shared secret, sent as the x-api-key header. */
  readonly VITE_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
