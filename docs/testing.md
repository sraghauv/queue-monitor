# Testing

## The four Vitest projects

Configured in `vitest.config.ts` as four named projects, each running one test tier:

| Project | Include pattern | Environment | What belongs here |
| --- | --- | --- | --- |
| `unit` | `tests/unit/**/*.test.ts` | `node` | Pure `src/domain/` and `src/app/` logic with no DOM: ranking, the session state machine, validation, readings/merging, the poller, metrics, the store, storage codecs. |
| `dom` | `tests/dom/**/*.test.ts` | `jsdom` | Anything that needs a real `Document`: content-script adapters (parsed HTML fixtures), popup rendering against the real `extension/popup.html` markup. |
| `integration` | `tests/integration/**/*.test.ts` | `node` | Cross-module workflows wired through the shared fakes — e.g. the scaling-ladder shape tests that run the real poller against `FakeTabs`/`FakeClock` at 100 tabs. |
| `security` | `tests/security/**/*.test.ts` | `node` | Adversarial input: the hostile-URL table against `validateUrl`. |

Run all four with `npm test`, or one at a time with `npm run test:unit`, `test:dom`,
`test:integration`, `test:security`. `npm run test:watch` runs Vitest in watch mode; `npm run
coverage` adds `@vitest/coverage-v8` reporting. Coverage excludes the three thin entry points
(`src/background/index.ts`, `src/popup/index.ts`, `src/content/index.ts`) per
`vitest.config.ts` — they're wiring, not logic, and are covered by the manual checklist below
instead.

## Shared fakes

Every test drives `tests/support/fakePlatform.ts` rather than writing its own mocks:

- `FakeClock` — a settable/advanceable clock (`now()`, `advance(ms)`, `set(ms)`).
- `FakeTimers` — manual timers (`schedule`, `cancel`, `runDue`, `runNext`); `delay()` resolves on
  the microtask queue, not a real timer.
- `FakeIdSource` — deterministic `session-N` ids.
- `FakeStorage` — an in-memory `StoragePort` with injectable one-shot read/write failures
  (`failNextRead`, `failNextWrite`).
- `FakeTabs` — an in-memory `TabsPort` with per-tab scripted behaviour (`setBehaviour`:
  `waiting`, `ready`, `unknown`, `timeout`, `throw`, `malformed`, `stale`), tracked peak
  concurrency (`peakConcurrency`), and `closeTab()` to simulate the user closing a tab.
- `reading(overrides)` — builds a `QueueReading` without repeating every field per test.

**Do not write a second set of browser fakes.** If a test needs new fake behaviour, extend
`FakeTabs`/`FakeStorage` in this file.

**No real timers or real sleeps.** Tests drive `FakeClock`/`FakeTimers` explicitly, which is why
the 100-tab integration test (`tests/integration/scaling.test.ts`) costs microseconds rather than
however long 100 real network round-trips would take.

## Required coverage

Per `AGENTS.md`, any change to the following areas requires covering these cases:

- **Ranking** — ties, `null`/`NaN` progress, all-zero progress, a `ready` tab, an empty set.
- **State machine** — every invalid transition, and idempotency of pause/resume/stop.
- **Validation** — non-`https:` schemes, `javascript:`, `data:`, `file:`, userinfo tricks
  (`https://allowed.example@evil.example`), host suffix tricks, trailing dots, case, and
  out-of-range or non-integer counts.
- **Polling** — timeout, out-of-order response, tab closed mid-round, malformed payload, bounded
  concurrency.
- **Recovery** — popup reopened, worker restarted, tabs closed while paused.

A passing unit test on a fake establishes that the fake's contract is honored — it does **not**
establish real Chrome behavior. Report what's actually been verified rather than implying
Chrome-level confidence from a test that never touched `chrome.*`.

## The manual Chrome checklist

Nothing above can exercise real Chrome — `chrome.tabs`, `chrome.storage`, real service-worker
suspension, or a real page's timing. This has to be done by hand, by loading the unpacked
extension (`npm run build`, then `chrome://extensions` → Developer mode → Load unpacked →
`dist/`) and working through:

- [ ] Load unpacked and open the popup with no prior session — confirm a clean idle state.
- [ ] Monitor 1 tab against the mock fixture (`npm run serve:mock`,
      `http://127.0.0.1:8787/?seed=1`) and watch it progress to ready.
- [ ] Monitor 5 tabs at once; confirm all five are tracked, readable, and rank sensibly.
- [ ] Let a tab reach `ready` (`?mode=normal` runs to completion) and confirm it's shown as its
      own top-priority state, not folded into the ranked score table.
- [ ] Close a tracked tab mid-monitor (from Chrome's own tab bar, not the extension) and confirm
      it's reconciled out — not retried forever, not left showing a stale number as current.
- [ ] Navigate a monitored tab away from the queue page and confirm the reading degrades to
      `unknown` rather than keeping a stale progress number.
- [ ] Click Stop and confirm every tracked tab is still open afterward.
- [ ] Close and reopen the popup mid-session and confirm it recovers the in-progress session
      rather than showing idle or opening a second batch of tabs.
- [ ] Let the service worker idle out (stop interacting with the extension long enough for
      Chrome to suspend it — `chrome://extensions` → the extension's "service worker" link shows
      "inactive"), then reopen the popup and confirm the session resumes correctly rather than
      being lost.
- [ ] Put the machine to sleep and resume it mid-session; confirm readings correctly show as
      stale by their age rather than silently presented as current, and that polling resumes.
- [ ] Attempt to start a session against a disallowed URL (any host not in the shipped
      allowlist, or a non-`https:`/non-loopback-`http:` scheme) and confirm it's refused with a
      clear error, with no tab opened.

## End-to-end tests

`npm run test:e2e` builds the extension and runs `tests/e2e/` under Playwright. These load the real
`dist/` into a real browser, serve `mock-queue/` over loopback, and drive the real popup. They are
the only tests that can show the extension works rather than that the fakes agree with each other —
every bug found after the unit suite went green was found here.

They are **not** part of `npm run check`: they need a browser installed and take about a minute.

```
npx playwright install chromium   # once
npm run test:e2e
```

Two constraints worth knowing before changing the harness:

- **It must be Chromium, not branded Google Chrome.** Chrome refuses `--load-extension` and
  `--disable-extensions-except` ("not allowed in Google Chrome, ignoring"). The browser still
  starts, the extension silently never loads, and every assertion then fails for a reason that
  looks like a product bug. Playwright's bundled build is Chrome for Testing, which honours both.
- **Match the service worker on `background.js`.** Chrome's own component extensions register
  service workers first, so `context.serviceWorkers()[0]` returns Google Network Speech and a
  wrong extension id.

Manual checking is still required for what Playwright cannot drive: real service-worker
suspension, machine sleep/resume, and Chrome's memory saver discarding tabs.

## Known gaps

- **`src/platform/chromeBrowser.ts` is covered only end-to-end.** It has no unit tests; what
  exercises it is the Playwright suite (`npm run test:e2e`), which loads the built extension into
  a real browser. That covers the paths the suite actually walks — tab creation, reads, focus,
  storage, closure — and not the error branches, notably the `tab-missing` detection that
  regex-matches Chrome's error message text. Treat that branch as unverified.
- **The three thin entry points** (`src/background/index.ts`, `src/popup/index.ts`,
  `src/content/index.ts`) are excluded from coverage reporting in `vitest.config.ts`. They are
  deliberately minimal wiring, but "minimal" is not "bug-free" — the end-to-end suite is what
  actually drives them.
- **`src/background/roundLoop.ts`'s real-time behaviour** (the `POPUP_IDLE_MS`/`ROUND_GAP_MS`
  timing against a live popup and a real suspended service worker) is not exercised by any
  automated test against real Chrome timing — only its logic shape, if covered at all, would be
  covered against `FakeTimers`. The "let the service worker idle out" and "sleep/resume" items
  above are the only way to actually verify it.
- **No end-to-end browser automation** (e.g. Playwright driving a real loaded extension) exists
  in this repo. Every item in the manual checklist is, for now, manual.
