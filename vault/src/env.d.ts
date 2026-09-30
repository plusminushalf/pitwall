// Baked in at build time by vault/vite.config.ts (vaultConstants).

/** The app origins allowed to embed the vault (VAULT_APP_ORIGINS). */
declare const __VAULT_APP_ORIGINS__: readonly string[];
/** The vault build, shown in `status`. */
declare const __VAULT_VERSION__: string;
/** True on the vault dev server only (`bun run vault`); false in `vault:build`, so dev knobs are dropped. */
declare const __VAULT_DEV__: boolean;
/** VAULT_FAKE_EXPIRES_IN on the dev server (seconds; 0 = off). Always 0 in a build. */
declare const __VAULT_FAKE_EXPIRES_IN__: number;
/**
 * VAULT_FAKE_BROKER on the dev server: the local fake broker's origin (vault/fakebroker.ts), e.g.
 * "http://127.0.0.1:5191"; the vault's MQTT URL and REST base then point at it. Always "" in a build.
 */
declare const __VAULT_FAKE_BROKER__: string;
