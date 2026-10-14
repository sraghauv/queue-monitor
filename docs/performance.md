# Performance

No benchmark has been run against real Chrome for this project. Nothing in this document is a
measured number — every figure below is either arithmetic (an implication of the design, labeled
as such) or a placeholder to be filled in once someone actually runs the scaling ladder in
Chrome. Do not treat anything here as a performance claim about the shipped extension.

## What to measure, and why

Per the implementation guide's section on performance (section 13):

- **Successful readings per second.**
- **Mean and P95 read latency.**
- **Estimated round duration** = tracked tabs ÷ successful readings per second.
- **Percentage of readings that are stale or failed**, each round.
- **CPU and memory footprint** while monitoring.
- **Recovery after sleep and after tab closure** — does the session resume cleanly, or does it
  lose track of tabs / duplicate work?

The reason to measure all of these rather than just "is it fast" is the guide's central claim
about where the cost actually lives: **the dominant cost is the web pages themselves — their
memory, their CPU, their own network activity — not the ranking sort.** `rank()`
(`src/domain/rank.ts`) is a single `O(n log n)` sort per round over whatever readings came back;
at 100 tabs that is a sort of 100 elements, which is not where time or memory goes in this
system. If a real run looks slow, the pages you opened are almost certainly why, not the code in
this repo that ranks them.

## Scaling ladder

Measure at each of: **1 → 5 → 10 → 25 → 50 → 100** tracked tabs. This matches both the
implementation guide and the default `--counts` the perf script uses.

## Bounded concurrency and per-tab timeouts

`src/app/poller.ts` reads tabs with a bounded worker pool (`DEFAULT_CONCURRENCY = 4`) and a
per-tab timeout (`DEFAULT_TIMEOUT_MS = 2_000`), not an unbounded `Promise.all` over every tracked
tab at once. Two reasons unbounded concurrency is the wrong shape at 100 tabs:

- **No backpressure.** `Promise.all(tabIds.map(readOne))` fires all 100 `chrome.tabs.sendMessage`
  calls in the same tick. Every one of those tabs' content scripts, and the message-passing
  machinery itself, now contends for CPU at once — exactly the "page memory/CPU is the dominant
  cost" problem above, except self-inflicted and synchronized to the worst possible moment.
- **No per-call timeout isolation.** Without a bounded pool it's natural to also skip individual
  timeouts and just await the whole batch — which means one tab that never answers (a hung page,
  a closed tab Chrome hasn't told you about yet) can stall the entire round rather than one
  worker slot. `src/app/poller.ts` races each read against its own timer
  (`src/platform/chromeBrowser.ts`'s `createChromeTabs().read`) specifically so a single
  unresponsive tab degrades to one `read-timeout` reading, not a frozen round.

A bounded pool of 4 means at most 4 tabs are being read at any instant, and a slow or hung tab
occupies one of those 4 slots for at most `timeoutMs`, never the whole round.

### What "100 tabs at 5 reads/s ≈ 20s per round" means

This is **arithmetic, not a measurement**: `100 tabs ÷ 5 reads/s = 20 seconds` for one full round
to visit every tracked tab once, *if* the extension can sustain 5 successful reads per second
against real Chrome tabs. Whether it actually sustains 5 reads/s, or something quite different,
is exactly what the scaling ladder above is for finding out. The popup's freshness display
(`formatFreshness` in `src/popup/format.ts`) exists so a user sees this number alongside the
score, rather than mistaking a 20-second-old reading for a live one.

## Results

No row below has been measured. Do not fill in a number unless it came from an actual run of the
procedure above against real Chrome, and label that run's date, build, and hardware alongside it.

| Tabs | Reads/s | Mean latency (ms) | P95 latency (ms) | Est. round duration | % stale/failed | CPU | Memory | Recovers after sleep | Recovers after tab closure |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| 5 | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| 10 | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| 25 | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| 50 | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| 100 | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |

## Running `npm run perf`

`npm run perf` runs `scripts/perf-report.mjs`. Read its own header comment before trusting
anything it prints — it is explicit that it is **not** a measurement of the real extension:

> Everything below measures the polling engine's own scheduling overhead against in-process fakes
> (`FakeTabs`/`FakeClock`). It bounds how much CPU and wall-clock time the scheduler itself burns
> running N concurrent `Promise`-based workers over a tab list — nothing more. It does NOT
> measure: Chrome's actual tab-to-content-script message passing latency, real content-script
> execution time in a live page, page memory or CPU usage inside tracked tabs (the guide
> identifies this as the dominant real-world cost, not the scheduler), [or] real network
> behaviour, queue-site latency, or browser scheduling under load.

What it actually does: it bundles the real `src/app/poller.ts` and `src/app/metrics.ts` (not a
mock of them) together with the shared `FakeTabs`/`FakeClock` test fakes, runs the scaling ladder
(1/5/10/25/50/100 tabs by default) for a configurable number of rounds against those fakes, and
prints reads/s, mean/P95 latency, estimated round duration, stale/failed/rejected counts, RSS
delta, and CPU time for each tab count — then writes the full run as JSON under
`perf-results/` (gitignored). It accepts `--counts=`, `--rounds=`, and `--failure-rate=` to
adjust the ladder, round count, and injected failure mix.

This is useful for catching a regression in the scheduler's own overhead (e.g. an accidental
unbounded-concurrency change, or an `O(n²)` creeping into a merge step) cheaply and
deterministically. It is **not** a substitute for the manual Chrome procedure below, and its
output must never be cited as a measurement of the extension's real-world throughput.

## The manual Chrome procedure

To get real numbers for the results table above:

1. `npm run build && npm run serve:mock`, load the unpacked extension, and open the popup.
2. For each rung of the scaling ladder (1, 5, 10, 25, 50, 100), point the extension at
   `http://127.0.0.1:8787/?seed=1` (or a `seed` per tab count, to stagger starting progress) with
   that tab count and click Start.
3. Let it run for a sustained period (several full rounds) and record, from the popup's own
   throughput/freshness display plus the OS/Chrome task manager: reads/s, the round duration
   you actually observe, the percentage of rows flagged stale, and Chrome's reported CPU/memory
   for the extension's renderer processes and the opened tabs.
4. Put the extension to sleep (let the machine sleep, or let the service worker idle out — see
   [docs/testing.md](./testing.md) "manual Chrome checklist") and confirm the session recovers on
   wake without duplicating tabs.
5. Close a tracked tab mid-round and confirm it's reconciled out rather than retried forever.
6. Record the real numbers in the table above, with the date, Chrome version, and hardware used.
