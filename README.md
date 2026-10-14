# Queue Monitor

Queue Monitor is a local-first Chrome extension. It opens a user-chosen number of tabs against
an **allowlisted** queue page, reads progress from those tabs through a content script, and
ranks the readings it actually obtained.

**It is a measurement tool, not a queue-position tool.** Opening more tabs does not produce more
or better queue entries — multiple tabs may share the same queue/session identity on the site
being monitored, and the extension has no way to know whether they do or don't. Everything this
tool reports is "here is what the tabs I opened showed me," never "here is your real position" or
"here is how likely you are to get through."

See [DISCLAIMER.md](./DISCLAIMER.md) before using this against any real site.

## Keeping a session running

Monitoring only advances while the popup is open. The background service worker in Manifest V3 can
be suspended at any time, so the round loop is deliberately tied to a live popup reporting in rather
than to a timer held in worker memory — a timer there would stop silently and the leaderboard would
go on looking current.

In practice that means:

- **Keep the popup open** while you want readings to update. Closing it leaves the session in
  storage; reopening it recovers the session and resumes, and in between the readings age and are
  shown as stale rather than presented as live.
- **Keep the computer awake.** A sleeping machine does not poll, and tabs may be discarded by
  Chrome's memory saver while it sleeps.
- Closing a monitored tab is fine — it is reconciled and shown as closed. Nothing in this extension
  closes a tab for you, including Stop.

## Status

- **Pre-release, MVP scope.** This implements the core monitor: allowlisted URL validation, tab
  creation, polling with bounded concurrency, ranking, pause/resume/stop, and a popup UI.
- **Chrome only.** No Safari build exists. Safari WebExtension packaging is explicitly out of
  scope for now.
- **No licensing/payment system.** There is no backend, no activation flow, and none is planned
  for this phase.
- The shipped allowlist contains **only loopback hosts** (`localhost`, `127.0.0.1`) for use with
  the bundled test fixture. No real ticketing site is supported out of the box — see
  [Allowlist](#allowlist) below.

## Install from source

There is no packaged release yet. To run the extension:

1. `npm ci`
2. `npm run build` — bundles into `dist/`.
3. Open `chrome://extensions` in Chrome.
4. Enable **Developer mode** (top right).
5. Click **Load unpacked** and select the `dist/` directory.

## Quick start

This walks the real flow end to end against the bundled local fixture.

```sh
npm ci
npm run build
npm run serve:mock
```

Then:

1. Load the unpacked extension from `dist/` as described above.
2. Open `http://localhost:8787/?seed=1` in a regular browser tab — this is the mock queue page
   served by `npm run serve:mock` (`mock-queue/index.html`), and it's useful to watch directly
   while the extension monitors it.
3. Open the extension's popup. Enter `http://localhost:8787/?seed=1` as the URL (or
   `http://127.0.0.1:8787/?seed=1` — both loopback hosts are allowlisted) and set a tab count.
4. Click **Start** to open tabs and begin monitoring (this is the "Open & Monitor" action — see
   the command table below).

`npm run serve:mock` binds to `127.0.0.1` only, never `0.0.0.0`, so the fixture is not reachable
from your network.

## Commands

The popup exposes four commands. Their actual button labels in `extension/popup.html` are
`Start`, `Pause`, `Resume`, and `Stop`.

| Button | Effect |
| --- | --- |
| **Start** (Open & Monitor) | Validates the URL and tab count against the allowlist, opens that many tabs, and begins polling. Refused outright if a session is already active — it never silently opens a second batch of tabs on top of an existing one. |
| **Pause** | Halts polling. Tabs stay open and the last readings are kept as-is. Idempotent: pausing while already paused is a no-op, not an error. |
| **Resume** | Re-checks that the tracked tabs still exist, then resumes polling. Idempotent while already monitoring. |
| **Stop** | Ends the session. **Stop never closes tabs.** No code path in this extension closes a tab you opened, ever — not Stop, not an error, not a reload. Idempotent while already stopped. |

Each row in the leaderboard also has a **Focus** button, which activates that tab and brings its
window forward (pausing monitoring first, so the tab's content doesn't shift under you mid-read).

## Reading the leaderboard

| Column | Meaning |
| --- | --- |
| Rank | 1-based competition rank among readings currently eligible to be ranked (status `waiting`, with a finite, in-range progress value). Ties share a rank. |
| Tab | The numeric Chrome tab ID. |
| Status | One of `Loading`, `Waiting`, `Ready`, `Unknown`, `Read error`, `Tab closed`. `Ready` is its own top-priority state, never just "100%". `Unknown`, error, and closed are distinct from a progress of zero — they mean the tool has no trustworthy number for that tab right now, not that the tab is at 0%. |
| Progress | The raw normalized 0..1 reading as a percent, or `—` when there isn't one. |
| Score | A 0..100 value relative to the **best progress observed among your own tabs this session**. Score 100 means "the best progress observed so far," not "100% chance of a ticket" and not a probability of anything. If every tracked tab is at 0 progress, score is `—`, not `0` — there's no meaningful ratio to show. |
| Last read | How long ago this tab's reading was taken, or "never". A reading older than the staleness window is marked stale in the UI rather than shown as current. |
| Actions | A **Focus** button to activate and bring that tab's window forward. |

**Row order is tracked-tab (creation) order, not rank.** Ranking never reorders or renumbers the
rows — a tab that falls behind stays in the same row position it has always occupied.

## Allowlist

The allowlist that ships with this repo (`src/config/allowlist.ts`) contains **only the local
loopback hosts** (`localhost`, `127.0.0.1`) used by `npm run serve:mock`. It does not, and will
not by default, contain any real ticketing or queue site.

Adding a host requires editing **both** of the following files, because they serve two different
purposes:

- `src/config/allowlist.ts` — this is the actual input-validation gate. It's what
  `src/domain/validation.ts` checks a user-typed URL against before the extension will act on it.
- `extension/manifest.json` — `host_permissions` and `content_scripts.matches` are Chrome's own
  permission grant. Without a matching entry here, Chrome will not let the extension inject its
  content script or message tabs on that origin at all.

Neither file alone is sufficient, and adding a host to either one is **not** a decision to make
lightly: monitoring a site's queue pages this way requires authorization from the operator of
that site. Do not add a host you are not authorized to monitor.

## Permissions and what this extension cannot see

`extension/manifest.json` requests:

- `permissions: ["tabs", "storage"]` — to open/query/focus tabs the user asked for, and to persist
  session state locally.
- `host_permissions: ["http://localhost/*", "http://127.0.0.1/*"]` — scoped to the shipped
  loopback allowlist only. No other host is reachable until a maintainer deliberately widens this
  (see [Allowlist](#allowlist)).

The content script never reads form inputs, password fields, payment fields, cookies,
`localStorage`, or arbitrary page text — it reads one normalized progress value and a status from
whatever adapter matched the page, nothing else. See [docs/privacy.md](./docs/privacy.md) for the
full accounting of what is and isn't collected.

## Development

Pinned Node version is in `.nvmrc`. Install with `npm ci`.

| Script | What it does |
| --- | --- |
| `npm run build` | Bundles the extension into `dist/` with esbuild and verifies every file `manifest.json` references was actually emitted. |
| `npm run build:watch` | Same, in watch mode. |
| `npm run typecheck` | `tsc --noEmit` under `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. |
| `npm run lint` | `oxlint` plus the module-boundary check (`scripts/verify-module-boundaries.mjs`). |
| `npm run lint:fix` | `oxlint --fix`. |
| `npm run format` / `npm run format:check` | `oxfmt`. |
| `npm test` | All Vitest projects. |
| `npm run test:unit` / `test:dom` / `test:integration` / `test:security` | One test tier at a time. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run coverage` | Vitest with coverage. |
| `npm run serve:mock` | Serves `mock-queue/` on `127.0.0.1:8787` for manual testing. |
| `npm run perf` | Measures polling throughput across the 1/5/10/25/50/100-tab scaling ladder. See [docs/performance.md](./docs/performance.md) — no numbers have been measured yet, and none are published here. |
| `npm run check` | The full local gate (`typecheck` + `lint` + `format:check` + `test`). Run before any commit. |

## More documentation

- [docs/architecture.md](./docs/architecture.md) — the four layers, the dependency rule, and the data-flow walkthrough.
- [docs/privacy.md](./docs/privacy.md) — exactly what is and isn't read, where data lives, how to delete it.
- [docs/performance.md](./docs/performance.md) — what to measure, the scaling ladder, and how to run `npm run perf`.
- [docs/testing.md](./docs/testing.md) — the test tiers, shared fakes, required coverage, and the manual Chrome checklist.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — toolchain, correctness rules, and contribution scope.
- [SECURITY.md](./SECURITY.md) — how to report a vulnerability and the trust boundaries.
- [DISCLAIMER.md](./DISCLAIMER.md) — read this before pointing this at anything other than the local test fixture.

## Legal and ethical use

This tool is for monitoring queue pages you are authorized to access. It contains no capability
to bypass waiting rooms, CAPTCHAs, bot detection, or rate limits, and none will be added. Read
[DISCLAIMER.md](./DISCLAIMER.md) in full before use.
