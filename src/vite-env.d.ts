/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Logo.dev publishable key (pk_…) for company logos. Client-exposed. */
  readonly VITE_LOGO_DEV_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
