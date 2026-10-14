/**
 * Boundary validation for user-typed input. This is the only place that
 * turns an untrusted string count and an untrusted string URL into values
 * the rest of the extension is allowed to act on. Every caller must use the
 * `URL` and `number` returned from here rather than re-deriving them from
 * the raw input — see AGENTS.md "Parse at the boundary".
 */

import { DEFAULT_ALLOWLIST, LOOPBACK_HOSTS, type AllowlistConfig } from "../config/allowlist.js";
import type { AppError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

/** Lowercases a hostname and strips a single trailing dot, for comparison. */
function normalizeHost(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeHost(hostname));
}

/** Exact-match check against the allowlist. No suffix or substring matching. */
export function isAllowedHost(host: string, config: AllowlistConfig = DEFAULT_ALLOWLIST): boolean {
  return config.hosts.has(normalizeHost(host));
}

export function validateCount(
  count: number,
  config: AllowlistConfig = DEFAULT_ALLOWLIST,
): Result<number, AppError> {
  const detail = `Enter a whole number of tabs between 1 and ${config.maxTabCount}.`;
  if (typeof count !== "number" || !Number.isFinite(count)) {
    return err({ kind: "invalid-count", detail });
  }
  if (!Number.isInteger(count)) {
    return err({ kind: "invalid-count", detail });
  }
  if (count < 1 || count > config.maxTabCount) {
    return err({ kind: "invalid-count", detail });
  }
  return ok(count);
}

export function validateUrl(
  raw: string,
  config: AllowlistConfig = DEFAULT_ALLOWLIST,
): Result<URL, AppError> {
  if (typeof raw !== "string") {
    return err({ kind: "invalid-url", detail: "URL must be a string." });
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err({ kind: "invalid-url", detail: "Could not parse as a URL." });
  }

  const scheme = url.protocol;
  const isHttps = scheme === "https:";
  const isAllowedInsecureLoopback =
    scheme === "http:" && config.allowInsecureLoopback && isLoopbackHost(url.hostname);
  if (!isHttps && !isAllowedInsecureLoopback) {
    return err({ kind: "unsupported-scheme", scheme });
  }

  if (url.username !== "" || url.password !== "") {
    return err({ kind: "invalid-url", detail: "URLs with embedded credentials are rejected." });
  }

  if (!isAllowedHost(url.hostname, config)) {
    return err({ kind: "unsupported-host", host: url.hostname });
  }

  return ok(url);
}

export function validateTarget(
  raw: string,
  count: number,
  config: AllowlistConfig = DEFAULT_ALLOWLIST,
): Result<{ url: URL; count: number }, AppError> {
  const urlResult = validateUrl(raw, config);
  if (!urlResult.ok) return urlResult;

  const countResult = validateCount(count, config);
  if (!countResult.ok) return countResult;

  return ok({ url: urlResult.value, count: countResult.value });
}
