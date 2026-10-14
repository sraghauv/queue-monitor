import { describe, expect, it } from "vitest";
import { allowlistOf } from "../../src/config/allowlist.js";
import type { AppError } from "../../src/domain/errors.js";
import { validateUrl } from "../../src/domain/validation.js";

/**
 * Adversarial inputs that must ALL be rejected. This suite is the thing
 * standing between a user-typed string and the extension opening tabs at an
 * attacker-controlled or locally-dangerous URL — see AGENTS.md.
 */
const HOSTILE_INPUTS: ReadonlyArray<{ raw: string; kind: AppError["kind"] }> = [
  // Disallowed schemes.
  { raw: "javascript:alert(1)", kind: "unsupported-scheme" },
  { raw: "javascript:void(0)//localhost", kind: "unsupported-scheme" },
  { raw: "data:text/html,<h1>x</h1>", kind: "unsupported-scheme" },
  { raw: "file:///etc/passwd", kind: "unsupported-scheme" },
  { raw: "blob:https://localhost/x", kind: "unsupported-scheme" },
  { raw: "chrome-extension://abc/x", kind: "unsupported-scheme" },
  { raw: "ftp://localhost/", kind: "unsupported-scheme" },
  { raw: "about:blank", kind: "unsupported-scheme" },
  { raw: "view-source:http://localhost/", kind: "unsupported-scheme" },

  // http: on a non-loopback host.
  { raw: "http://evil.example/", kind: "unsupported-scheme" },

  // Userinfo tricks: a careless string parse would see "localhost" first.
  { raw: "https://localhost@evil.example/", kind: "invalid-url" },
  { raw: "https://localhost:pw@evil.example/", kind: "invalid-url" },

  // Host suffix / lookalike tricks. Exact match only, no suffix matching.
  { raw: "https://localhost.evil.example/", kind: "unsupported-host" },
  { raw: "https://evil-localhost/", kind: "unsupported-host" },
  { raw: "https://notlocalhost/", kind: "unsupported-host" },

  // The allowed host appearing only in query or fragment, not as the host.
  { raw: "https://evil.example/?u=https://localhost/", kind: "unsupported-host" },
  { raw: "https://evil.example/#localhost", kind: "unsupported-host" },

  // Punycode lookalike: must not collapse to "localhost" under exact match.
  { raw: "https://xn--lcalhost-5za/", kind: "unsupported-host" },

  // Garbage / unparseable / protocol-relative input.
  { raw: "", kind: "invalid-url" },
  { raw: "   ", kind: "invalid-url" },
  { raw: "not a url", kind: "invalid-url" },
  { raw: "//localhost/", kind: "invalid-url" },
];

describe("validateUrl rejects hostile input", () => {
  for (const { raw, kind } of HOSTILE_INPUTS) {
    it(`rejects ${JSON.stringify(raw)} as ${kind}`, () => {
      const result = validateUrl(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe(kind);
      }
    });
  }
});

describe("validateUrl normalization edge case", () => {
  it("accepts https://LOCALHOST./ (case + single trailing dot normalize to the allowed host)", () => {
    const result = validateUrl("https://LOCALHOST./");
    expect(result.ok).toBe(true);
  });
});

describe("validateUrl loopback http gating", () => {
  it("rejects http://localhost/ when allowInsecureLoopback is false", () => {
    const config = allowlistOf(["localhost"], { allowInsecureLoopback: false });
    const result = validateUrl("http://localhost/", config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("unsupported-scheme");
    }
  });

  it("rejects everything, including loopback, when the allowlist is empty", () => {
    const config = allowlistOf([]);
    const httpsResult = validateUrl("https://localhost/", config);
    expect(httpsResult.ok).toBe(false);
    if (!httpsResult.ok) {
      expect(httpsResult.error.kind).toBe("unsupported-host");
    }

    const httpResult = validateUrl("http://localhost/", config);
    expect(httpResult.ok).toBe(false);
    if (!httpResult.ok) {
      expect(httpResult.error.kind).toBe("unsupported-host");
    }
  });
});
