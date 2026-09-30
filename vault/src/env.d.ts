// Baked in at build time by vault/vite.config.ts (vaultConstants).

/** The app origins allowed to embed the vault (VAULT_APP_ORIGINS). */
declare const __VAULT_APP_ORIGINS__: readonly string[];
/** The vault build, shown in `status`. */
declare const __VAULT_VERSION__: string;
/** True on the vault dev server only (`bun run vault`); false in `vault:build`, so dev knobs are dropped. */
declare const __VAULT_DEV__: boolean;
/** VAULT_FAKE_EXPIRES_IN on the dev server (seconds; 0 = off). Always 0 in a build. */
declare const __VAULT_FAKE_EXPIRES_IN__: number;
