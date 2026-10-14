import { describe, expect, it } from "vitest";
import { allowlistOf, DEFAULT_ALLOWLIST } from "../../src/config/allowlist.js";
import {
  isAllowedHost,
  validateCount,
  validateTarget,
  validateUrl,
} from "../../src/domain/validation.js";

describe("validateUrl happy paths", () => {
  it("accepts an https loopback URL on the default allowlist", () => {
    const result = validateUrl("https://localhost/queue?x=1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeInstanceOf(URL);
      expect(result.value.hostname).toBe("localhost");
    }
  });

  it("accepts http for a loopback host when allowInsecureLoopback is true", () => {
    const result = validateUrl("http://127.0.0.1:8080/mock");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hostname).toBe("127.0.0.1");
    }
  });

  it("returns the normalized URL rather than a re-parse of the raw string", () => {
    const result = validateUrl("https://LOCALHOST./queue");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The returned URL is the parsed, normalized value: lowercase host.
      expect(result.value.hostname).toBe("localhost.");
      expect(result.value.href).toBe("https://localhost./queue");
    }
  });

  it("accepts a custom allowlist host", () => {
    const config = allowlistOf(["example.com"], { allowInsecureLoopback: false });
    const result = validateUrl("https://example.com/path", config);
    expect(result.ok).toBe(true);
  });
});

describe("isAllowedHost", () => {
  it("matches exactly, case-insensitively, trailing-dot tolerant", () => {
    expect(isAllowedHost("localhost")).toBe(true);
    expect(isAllowedHost("LOCALHOST")).toBe(true);
    expect(isAllowedHost("localhost.")).toBe(true);
    expect(isAllowedHost("localhost.evil.example")).toBe(false);
    expect(isAllowedHost("notlocalhost")).toBe(false);
  });

  it("respects a custom allowlist config", () => {
    const config = allowlistOf(["Example.COM"]);
    expect(isAllowedHost("example.com", config)).toBe(true);
    expect(isAllowedHost("localhost", config)).toBe(false);
  });
});

describe("validateCount matrix", () => {
  const cases: Array<[unknown, boolean]> = [
    [0, false],
    [1, true],
    [100, true],
    [101, false],
    [-1, false],
    [1.5, false],
    [NaN, false],
    [Infinity, false],
    [-Infinity, false],
    ["5" as unknown, false],
  ];

  for (const [input, expectedOk] of cases) {
    it(`count=${String(input)} -> ok=${expectedOk}`, () => {
      const result = validateCount(input as unknown as number);
      expect(result.ok).toBe(expectedOk);
      if (!result.ok) {
        expect(result.error.kind).toBe("invalid-count");
      }
    });
  }

  it("respects a custom maxTabCount", () => {
    const config = allowlistOf(["localhost"], { maxTabCount: 5 });
    expect(validateCount(5, config).ok).toBe(true);
    expect(validateCount(6, config).ok).toBe(false);
  });
});

describe("validateTarget", () => {
  it("returns url and count together on success", () => {
    const result = validateTarget("https://localhost/q", 10);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.url.hostname).toBe("localhost");
      expect(result.value.count).toBe(10);
    }
  });

  it("returns the URL error first when both url and count are invalid", () => {
    const result = validateTarget("javascript:alert(1)", -5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("unsupported-scheme");
    }
  });

  it("returns the count error when the url is valid but the count is not", () => {
    const result = validateTarget("https://localhost/", 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid-count");
    }
  });

  it("uses DEFAULT_ALLOWLIST when no config is given", () => {
    const result = validateTarget("https://localhost/", 1);
    expect(result.ok).toBe(true);
    expect(DEFAULT_ALLOWLIST.hosts.has("localhost")).toBe(true);
  });
});
