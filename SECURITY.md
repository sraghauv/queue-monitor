# Security Policy

## Reporting a vulnerability

Please report security issues privately, not as a public GitHub issue. Open a
[GitHub Security Advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
on this repository rather than filing a regular issue or discussing it publicly. We don't yet have
a dedicated security contact address to publish here; the security advisory flow is the
supported channel for now. Please allow a reasonable window for a response and a fix before any
public disclosure.

## Trust boundaries

This extension treats several things as untrusted input, not as facts it can rely on:

- **Page content is untrusted.** Anything a content script reads off a page — including the
  normalized progress value and the matched adapter id — originates from a document the
  extension does not control. It is parsed by `src/domain/messages.ts` before use and is never
  rendered with `innerHTML` or interpolated into executable code; see `src/popup/render.ts`,
  which builds every DOM node with `textContent`.
- **Extension messages are untrusted.** `chrome.runtime.onMessage` is reachable from any context
  that can message this extension. Every inbound command and reading is parsed by a
  `src/domain/` parser (`parsePopupCommand`, `parseContentReading`) before anything acts on it —
  shape is never assumed from a cast.
- **Stored state is untrusted.** Values coming back out of `chrome.storage` are treated as
  boundary input exactly like a network message: a previous extension version, a corrupted
  profile, or a partial write can all leave something unexpected behind. `src/platform/storageCodec.ts`
  parses every stored session and reading field-by-field and drops anything it can't validate,
  rather than trusting the shape.
- **The popup is not a security boundary.** The popup performs cheap client-side validation only
  as a fast-feedback convenience. The background/coordinator layer (`src/app/coordinator.ts`)
  revalidates the URL and tab count against the allowlist independently, because a command can
  arrive at the background from any extension context, not only from the popup's own UI.

## In scope

- Allowlist bypass: any input that causes a tab to be opened against a host not present in both
  `src/config/allowlist.ts` and `extension/manifest.json`.
- Message forgery: any way to make the background act on a forged `PopupCommand` or
  `ContentReading` that should have been rejected by parsing.
- Injection through page-derived strings: any way a page's content (adapter id, error text,
  progress value) ends up executed or rendered as markup rather than literal text.
- Data exfiltration beyond progress readings: any code path that sends data off the user's
  machine, or that reads more than the normalized progress/status/adapter/timestamp contract
  documented in [docs/privacy.md](./docs/privacy.md).

## Out of scope

- Anything that requires the user to deliberately add a hostile host to their own allowlist
  (editing `src/config/allowlist.ts` and `extension/manifest.json` and rebuilding). That's a
  self-inflicted configuration change, not a vulnerability in the shipped extension.

## Posture

- **Minimal permissions.** `extension/manifest.json` requests only `tabs` and `storage`, scoped
  host permissions to the loopback hosts in the shipped allowlist, and nothing else.
- **No backend.** There is no server this extension talks to.
- **No telemetry.** Nothing is sent anywhere. See [docs/privacy.md](./docs/privacy.md) for the
  full accounting of what is read and where it's stored.
