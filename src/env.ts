/**
 * Worker bindings and configuration.
 *
 * These come from the `wrangler.jsonc` bindings and from Workers secrets.
 * They replace the `process.env` values the original Express server read via dotenv.
 */
export interface Env {
  /** Browser Rendering binding (see `browser` in wrangler.jsonc). */
  BROWSER: Fetcher;

  /** KV namespace used to cache login cookies, keyed by a credential hash. */
  COOKIE_CACHE: KVNamespace;

  // All of the values below are stored as secrets, not in wrangler.jsonc.
  // Set each with `wrangler secret put <NAME>` (or a gitignored .dev.vars locally).

  /** Base URL of the Legacy Library site. */
  LEGACY_SITE_URL?: string;

  /** YCL (digital assets) configuration. Digital search is skipped when YCL_HOST is unset. */
  YCL_HOST?: string;
  YCL_PROTOCOL?: string;
  /** Your digital library slug. */
  YCL_LIBRARY_SLUG?: string;
  YCL_AUTH_URL?: string;
}
