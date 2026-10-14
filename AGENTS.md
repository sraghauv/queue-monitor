# Repository Guidelines

## Product and Authority

Queue Monitor is a local-first Chrome extension. It opens a user-chosen number of tabs against an
**allowlisted** queue page, reads progress from those pages through a content script, and ranks the
readings it actually obtained. It is a measurement tool, not a queue-position tool.

Three claims must never appear in code, UI, docs, or commit messages:

- that more tabs produce more or better queue entries,
- that a relative score is a probability of getting tickets,
- that a stale reading is a current one.

Never add code that bypasses waiting rooms, CAPTCHAs, bot detection, or rate limits. Never read
checkout inputs, credentials, cookies, payment fields, or unrelated browsing data. The shipped
allowlist contains only the local development fixture; adding a host is the operator's decision and
requires authorization for that site.

## Architecture

Dependencies flow inward. A module may import only from layers above it in this list:

1. `src/domain/` — pure contracts, ranking, state machine, validation, message parsing. No
   `chrome` namespace, no DOM, no I/O, no imports from any other `src/` layer except `src/domain/`.
2. `src/platform/` — ports (interfaces) to the browser plus their `chrome` implementations. The
   only layer permitted to touch the `chrome` namespace.
3. `src/app/` — workflows: store, poller, metrics, coordinator. Depends on `src/domain/` and on
   `src/platform/browser.js` **interfaces only**, never on `chromeBrowser.js`.
4. `src/background/`, `src/popup/`, `src/content/` — thin entry points that wire concrete
   implementations to the layers above. Keep logic here to a minimum; it is the least testable code
   in the repo.

`npm run lint` enforces this with `scripts/verify-module-boundaries.mjs`. A layering violation is a
build failure, not a style note.

## Correctness Rules

These encode the failure modes this product is most likely to ship:

- **Unknown is not zero.** `unknown`, `error`, and `closed` are distinct states from `progress: 0`.
  Never substitute one for the other, and never reuse a previous numeric value when the current read
  failed.
- **Parse at the boundary.** Every message, stored value, and URL is parsed into `Result` by a
  `src/domain/` parser before use. Page-derived values are untrusted input.
- **Never throw across a port.** `TabsPort` and `StoragePort` implementations return
  `Result<_, AppError>`. Tagged errors from `src/domain/errors.ts` carry the cause; add a variant
  rather than widening an existing one.
- **Tab identity is numeric.** Track `chrome` tab IDs. Tab creation order is not rank, and ranking
  must never reorder or renumber the tracked IDs.
- **Sequence numbers win.** Readings carry a monotonic `seq`. A response whose `seq` is not greater
  than the accepted one for that tab is discarded, not merged.
- **No overlapping rounds.** One polling round per session at a time.
- **Idempotent commands.** `PAUSE` while paused, `RESUME` while monitoring, and `STOP` while
  stopped all succeed without changing anything. Genuinely invalid transitions return
  `invalid-transition`.
- **Stop never closes tabs.** No code path closes a user's tab.
- **Render with `textContent`.** Never `innerHTML`, never `eval`, never a string-built DOM from page
  data.

## Development

Pinned toolchain in `.nvmrc`. Install with `npm ci`.

- `npm run build` — bundle into `dist/`, then verify every `manifest.json` reference was emitted.
- `npm run typecheck` — `tsc --noEmit` under `strict` plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`.
- `npm run lint` — `oxlint` and the module-boundary check.
- `npm run format` / `format:check` — `oxfmt`.
- `npm test` — all vitest projects. `test:unit`, `test:dom`, `test:integration`, `test:security`
  run one tier.
- `npm run serve:mock` — serve `mock-queue/` for manual testing.
- `npm run perf` — measure polling throughput at 1/5/10/25/50/100 tabs.
- `npm run check` — the full local gate. Run it before any commit.

## Testing

Use the shared fakes in `tests/support/fakePlatform.ts`. Do not write a second set of browser fakes;
extend those. Tests must not use real timers or real sleeps — `FakeClock` and `FakeTimers` make
rounds deterministic, so a 100-tab round costs microseconds.

Required coverage for any change to the areas below:

- ranking: ties, `null`/`NaN` progress, all-zero progress, a `ready` tab, an empty set;
- state machine: every invalid transition, and idempotency of pause/resume/stop;
- validation: non-https schemes, `javascript:`, `data:`, `file:`, userinfo tricks
  (`https://allowed.example@evil.example`), host suffix tricks, trailing dots, case, and out-of-range
  or non-integer counts;
- polling: timeout, out-of-order response, tab closed mid-round, malformed payload, bounded
  concurrency;
- recovery: popup reopened, worker restarted, tabs closed while paused.

Report unverified coverage explicitly. A passing unit test on a fake does not establish real Chrome
behaviour; say so rather than implying it.

## Commits

Conventional Commit subjects. Mark breaking changes with `!`. Describe behavior changes and the
validation that was actually run — not the validation that would be nice to have.
