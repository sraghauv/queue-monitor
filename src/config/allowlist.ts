/**
 * The SHIPPED host allowlist.
 *
 * This file contains ONLY the local development fixture used by
 * `npm run serve:mock`. It must never contain a real ticketing host.
 *
 * Adding a host here is a deliberate operator decision, not a code change to
 * take lightly: it requires authorization from the operator of that site to
 * monitor its queue pages. Adding a host here also does nothing on its own —
 * it must be mirrored in `extension/manifest.json` under `host_permissions`
 * and `content_scripts.matches`, or Chrome will not grant the extension
 * access to that origin in the first place. Conversely, granting the
 * manifest permission without adding the host here does nothing either: this
 * allowlist is the actual input-validation gate that `src/domain/validation.ts`
 * enforces against user-typed URLs. Neither file alone is sufficient; both
 * must agree before a host is reachable end to end.
 */

export type AllowlistConfig = {
  readonly hosts: ReadonlySet<string>;
  /** Permits http: for loopback hosts only, for the local mock fixture. */
  readonly allowInsecureLoopback: boolean;
  readonly maxTabCount: number;
};

/**
 * Loopback hosts the development fixture may be served from.
 *
 * `[::1]` is deliberately absent. Chrome's match patterns cannot express an
 * IPv6 literal, so `extension/manifest.json` has no way to grant the host
 * permission for it — allowing it here would produce a URL this validator
 * accepts and Chrome then refuses to let the content script read, which looks
 * to the user like a broken monitor rather than an unsupported address.
 */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

export const DEFAULT_ALLOWLIST: AllowlistConfig = {
  hosts: LOOPBACK_HOSTS,
  allowInsecureLoopback: true,
  maxTabCount: 100,
};

/**
 * Builds an `AllowlistConfig` from a list of hosts, lowercasing and trimming
 * each before storing it. `overrides` replaces individual fields of the
 * default config (e.g. `maxTabCount`, `allowInsecureLoopback`); it does not
 * merge into `hosts` — pass the full desired host list in `hosts`.
 */
export function allowlistOf(
  hosts: readonly string[],
  overrides?: Partial<AllowlistConfig>,
): AllowlistConfig {
  const normalized = new Set(hosts.map((host) => host.trim().toLowerCase()));
  return {
    hosts: normalized,
    allowInsecureLoopback: DEFAULT_ALLOWLIST.allowInsecureLoopback,
    maxTabCount: DEFAULT_ALLOWLIST.maxTabCount,
    ...overrides,
  };
}
