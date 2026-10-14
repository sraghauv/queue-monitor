# Contributing

## Toolchain

Node version is pinned in `.nvmrc`. Use it (`nvm use`, or your tool's equivalent) and then:

```sh
npm ci
```

Do not `npm install` for routine work — `npm ci` installs exactly what `package-lock.json` pins.

## Scripts

All real scripts are defined in `package.json`:

- `npm run build` / `npm run build:watch` — bundle into `dist/` with esbuild; `build` also
  verifies every file `extension/manifest.json` references was actually emitted.
- `npm run typecheck` — `tsc --noEmit` under `strict`, `noUncheckedIndexedAccess`, and
  `exactOptionalPropertyTypes`.
- `npm run lint` / `npm run lint:fix` — `oxlint` plus `scripts/verify-module-boundaries.mjs`.
- `npm run format` / `npm run format:check` — `oxfmt`.
- `npm test`, `npm run test:unit`, `test:dom`, `test:integration`, `test:security`, `test:watch`,
  `npm run coverage` — see [docs/testing.md](./docs/testing.md).
- `npm run serve:mock` — serves `mock-queue/` on `127.0.0.1:8787`.
- `npm run perf` — the `npm run perf` → `scripts/perf-report.mjs` performance measurement; see
  [docs/performance.md](./docs/performance.md).
- `npm run check` — the full local gate. **Run this before any commit.**

## The layering rule

Dependencies flow inward only. A module may import only from layers at or above it:

1. `src/domain/` — pure contracts, ranking, state machine, validation, message parsing. No
   `chrome` namespace, no DOM, no I/O, no imports from any other `src/` layer except
   `src/domain/` itself.
2. `src/platform/` — ports (interfaces) in `browser.ts` plus their `chrome` implementations in
   `chromeBrowser.ts`/`storageCodec.ts`. The only layer permitted to touch the `chrome` namespace.
3. `src/app/` — workflows (`store.ts`, `poller.ts`, `metrics.ts`, `coordinator.ts`). Depends on
   `src/domain/` and on `src/platform/browser.ts` **interfaces only**, never on
   `src/platform/chromeBrowser.ts`.
4. `src/background/`, `src/popup/`, `src/content/` — thin entry points that wire concrete
   implementations to the layers above. Keep logic here to a minimum; it is the least testable
   code in the repo.

`npm run lint` enforces this with `scripts/verify-module-boundaries.mjs`. **A layering violation
is a build failure, not a style note.** If you find yourself importing `chromeBrowser.js` from
`src/app/`, or reaching for `chrome.*` from `src/domain/`, that's the boundary telling you the
change belongs somewhere else.

## Correctness rules you are most likely to break

These are the failure modes this product is most likely to ship, taken from `AGENTS.md`:

- **Unknown is not zero.** `unknown`, `error`, and `closed` are distinct states from
  `progress: 0`. Never substitute one for the other, and never reuse a previous numeric value
  when the current read failed.
- **Parse at the boundary.** Every message, stored value, and URL is parsed into a `Result` by a
  `src/domain/` parser before use (`parseContentReading`, `parsePopupCommand`, `validateUrl`,
  `validateCount`, `parseStoredSession`, `parseStoredReadings`). Page-derived values are
  untrusted input — never trust a shape by casting it.
- **Never throw across a port.** `TabsPort` and `StoragePort` implementations return
  `Result<_, AppError>`. If you add a new failure mode, add a variant to `AppError` in
  `src/domain/errors.ts` rather than widening an existing one or throwing.
- **Tab identity is numeric.** Track `chrome` tab IDs. Tab creation order is not rank, and
  ranking must never reorder or renumber the tracked IDs (`orderByTabIds` exists for exactly
  this).
- **Sequence numbers win.** Readings carry a monotonic `seq`. A response whose `seq` is not
  greater than the accepted one for that tab is discarded, not merged (`mergeReading`).
- **No overlapping rounds.** One polling round per session at a time (`Poller.isRunning`/the
  in-flight-round guard in `createPoller`).
- **Idempotent commands.** `PAUSE` while paused, `RESUME` while monitoring, and `STOP` while
  stopped all succeed without changing anything. Genuinely invalid transitions return
  `invalid-transition`. The transition table lives in `src/domain/session.ts` as data, not a
  `switch`, so it can't disagree with itself.
- **Stop never closes tabs.** No code path closes a user's tab. There is no call to
  `chrome.tabs.remove` anywhere in this codebase, and there should never be one.
- **Render with `textContent`.** Never `innerHTML`, never `eval`, never a string-built DOM from
  page-derived data (adapter ids, error strings). `src/popup/render.ts` builds every row with
  `document.createElement` + `.textContent`.

## Tests

See [docs/testing.md](./docs/testing.md) for the full breakdown. In short:

- Use the shared fakes in `tests/support/fakePlatform.ts` — `FakeClock`, `FakeTimers`,
  `FakeStorage`, `FakeTabs`, `FakeIdSource`, and the `reading()` builder. **Do not write a second
  set of browser fakes; extend those.**
- Tests must not use real timers or real sleeps. `FakeClock`/`FakeTimers` make rounds
  deterministic, so a 100-tab round costs microseconds in a test, not seconds.
- A new test belongs in `tests/unit/` for pure domain/app logic, `tests/dom/` for anything that
  needs a real `Document` (adapters, popup rendering), `tests/integration/` for cross-module
  workflows wired through the fakes, or `tests/security/` for adversarial input.

## Commits

Conventional Commit subjects (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, etc.). Mark breaking
changes with `!`. Describe the behavior change and the validation **actually run** — not the
validation that would be nice to have. "Ran `npm run check`" is a fact; "should work in Chrome"
is not, unless you loaded the unpacked extension and checked.

## Contribution scope requiring maintainer sign-off

The following categories of change need maintainer sign-off **before implementation work
starts**, not just before merge:

- Adding a real-site adapter (anything beyond the `progress-element` fixture adapter).
- Broadening `host_permissions` or the allowlist beyond loopback hosts.
- Adding any network call the extension makes on its own behalf (there are currently none).
- Adding a licensing or payment system.

Each of these changes what this extension is authorized to touch, and that's not a call to make
unilaterally in a pull request.
