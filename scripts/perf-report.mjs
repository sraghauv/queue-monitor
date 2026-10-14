#!/usr/bin/env node
/**
 * Scaling ladder perf harness: measures the REAL `src/app/poller.ts` running
 * bounded-concurrency rounds against an in-process `FakeTabs`, at the tab
 * counts the implementation guide's section 13 calls out (1, 5, 10, 25, 50,
 * 100). There is no runtime TS loader configured for this repo, so the
 * poller, metrics, and fake platform are bundled on the fly with the
 * already-installed `esbuild` and dynamically imported from a temp file.
 *
 * READ THIS BEFORE TRUSTING A NUMBER THIS SCRIPT PRINTS:
 *
 * Everything below measures the polling engine's own scheduling overhead
 * against in-process fakes (`FakeTabs`/`FakeClock`). It bounds how much CPU
 * and wall-clock time the scheduler itself burns running N concurrent
 * `Promise`-based workers over a tab list — nothing more. It does NOT
 * measure:
 *   - Chrome's actual tab-to-content-script message passing latency,
 *   - real content-script execution time in a live page,
 *   - page memory or CPU usage inside tracked tabs (the guide identifies
 *     this as the dominant real-world cost, not the scheduler),
 *   - real network behaviour, queue-site latency, or browser scheduling
 *     under load.
 * A number below being fast does NOT mean the extension is fast in Chrome.
 * For real figures, run the manual Chrome procedure in docs/performance.md.
 * Never cite a number from this script as a measurement of the extension.
 */

import { build } from "esbuild";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const CAVEAT_LINES = [
  "CAVEAT: these numbers measure the polling engine's own scheduling overhead",
  "against in-process fakes (FakeTabs/FakeClock). They bound the scheduler's",
  "overhead and nothing else. They do NOT measure Chrome's message passing,",
  "content-script execution, page memory/CPU, or real network behaviour --",
  "the guide identifies those as the dominant real-world costs. Real figures",
  "require the manual Chrome procedure in docs/performance.md. Do not cite a",
  "number from this script as a measurement of the extension.",
];

const root = resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const options = {
    counts: [1, 5, 10, 25, 50, 100],
    rounds: 20,
    failureRate: 0.05,
  };
  for (const arg of argv) {
    if (arg.startsWith("--counts=")) {
      options.counts = arg
        .slice("--counts=".length)
        .split(",")
        .map((s) => Math.trunc(Number(s.trim())))
        .filter((n) => Number.isInteger(n) && n > 0);
    } else if (arg.startsWith("--rounds=")) {
      options.rounds = Math.trunc(Number(arg.slice("--rounds=".length)));
    } else if (arg.startsWith("--failure-rate=")) {
      options.failureRate = Number(arg.slice("--failure-rate=".length));
    }
  }
  if (!Number.isInteger(options.rounds) || options.rounds < 1) {
    throw new Error(`--rounds must be a positive integer, got ${options.rounds}`);
  }
  if (!Number.isFinite(options.failureRate) || options.failureRate < 0 || options.failureRate > 1) {
    throw new Error(`--failure-rate must be between 0 and 1, got ${options.failureRate}`);
  }
  if (options.counts.length === 0) {
    throw new Error("--counts produced no usable tab counts");
  }
  return options;
}

/**
 * Bundles the real poller/metrics modules plus the shared test fakes into
 * one ESM file via esbuild (write: false), writes the result to a temp
 * directory under os.tmpdir(), and dynamically imports it. Returns the
 * imported module and a cleanup function; callers must call cleanup() in a
 * finally block.
 */
async function loadRealModules() {
  const entrySource = [
    `export { createPoller, DEFAULT_CONCURRENCY, DEFAULT_TIMEOUT_MS } from ${JSON.stringify(
      resolve(root, "src/app/poller.ts"),
    )};`,
    `export { percentile } from ${JSON.stringify(resolve(root, "src/app/metrics.ts"))};`,
    `export { FakeTabs, FakeClock } from ${JSON.stringify(
      resolve(root, "tests/support/fakePlatform.ts"),
    )};`,
  ].join("\n");

  const tempDir = await mkdtemp(join(tmpdir(), "queue-monitor-perf-"));
  const entryPath = join(tempDir, "entry.mjs");
  const bundlePath = join(tempDir, "bundle.mjs");

  try {
    await writeFile(entryPath, entrySource, "utf8");
    const result = await build({
      entryPoints: [entryPath],
      bundle: true,
      platform: "node",
      format: "esm",
      target: `node${process.versions.node.split(".")[0]}`,
      write: false,
      logLevel: "silent",
    });
    const output = result.outputFiles[0];
    if (output === undefined) {
      throw new Error("esbuild produced no output for the perf harness entry");
    }
    await writeFile(bundlePath, output.text, "utf8");
    const mod = await import(pathToFileURL(bundlePath).href);
    return { mod, cleanup: () => rm(tempDir, { recursive: true, force: true }) };
  } catch (cause) {
    await rm(tempDir, { recursive: true, force: true });
    throw cause;
  }
}

/** Deterministic-ish behaviour assignment so the failure mix is reproducible per run. */
function assignBehaviour(index, failureRate, rng) {
  if (rng() >= failureRate) {
    return { kind: "waiting", progress: Math.min(1, (index % 97) / 97) };
  }
  const bucket = Math.floor(rng() * 4);
  switch (bucket) {
    case 0:
      return { kind: "timeout" };
    case 1:
      return { kind: "throw", detail: "injected perf-harness failure" };
    case 2:
      return { kind: "unknown" };
    default:
      return { kind: "stale", seq: 0, progress: 0.1 };
  }
}

/** Small mulberry32 PRNG so repeated runs with the same seed are reproducible. */
function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Opens `count` fake tabs and assigns each one a behaviour. */
async function setUpFakeTabs(tabs, count, failureRate) {
  const rng = makeRng(0xc0ffee ^ count);
  const tabIds = [];
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const created = await tabs.create(`https://queue.example.com/perf/${i}`);
    if (created.ok) {
      tabIds.push(created.value);
      tabs.setBehaviour(created.value, assignBehaviour(i, failureRate, rng));
    }
  }
  return tabIds;
}

/** Runs `rounds` sequential polling rounds and accumulates raw per-round facts. */
async function runRounds(poller, tabIds, rounds) {
  let prior = [];
  let seq = 0;
  let accepted = 0;
  let failed = 0;
  let rejectedStale = 0;
  const latencies = [];
  const roundDurations = [];
  let peakRss = process.memoryUsage().rss;

  for (let round = 0; round < rounds; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await poller.runRound({ tabIds, prior, seq });
    prior = result.readings;
    seq = result.nextSeq;
    accepted += result.accepted;
    failed += result.failed;
    rejectedStale += result.rejectedStale;
    roundDurations.push(result.finishedAt - result.startedAt);
    for (const reading of result.readings) {
      if (reading.latencyMs !== undefined) latencies.push(reading.latencyMs);
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }

  return { accepted, failed, rejectedStale, latencies, roundDurations, peakRss };
}

/** Turns raw per-round facts into the reported row shape. */
function summarizeRun(count, options, raw, elapsedMs, cpuUsage, rssDeltaBytes, percentile) {
  const { accepted, failed, rejectedStale, latencies, roundDurations } = raw;
  const elapsedSeconds = elapsedMs / 1000;
  const readsPerSecond = elapsedSeconds > 0 ? accepted / elapsedSeconds : null;
  const meanLatencyMs =
    latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
  const meanRoundDurationMs =
    roundDurations.length > 0
      ? roundDurations.reduce((a, b) => a + b, 0) / roundDurations.length
      : null;
  const estimatedRoundDurationMs =
    readsPerSecond !== null && readsPerSecond > 0 ? (count / readsPerSecond) * 1000 : null;

  return {
    tabsTracked: count,
    roundsRun: options.rounds,
    accepted,
    failed,
    rejectedStale,
    elapsedMs,
    readsPerSecond,
    meanLatencyMs,
    p95LatencyMs: percentile(latencies, 95),
    meanRoundDurationMs,
    estimatedRoundDurationMs,
    peakRssDeltaBytes: rssDeltaBytes,
    cpuUserMs: cpuUsage.user / 1000,
    cpuSystemMs: cpuUsage.system / 1000,
  };
}

async function runForCount(mod, count, options) {
  const { createPoller, FakeTabs, FakeClock, percentile } = mod;
  const tabs = new FakeTabs();
  const clock = new FakeClock();
  const poller = createPoller({ tabs, clock });

  const tabIds = await setUpFakeTabs(tabs, count, options.failureRate);

  const cpuBefore = process.cpuUsage();
  const rssBefore = process.memoryUsage().rss;
  const wallStart = performance.now();

  const raw = await runRounds(poller, tabIds, options.rounds);

  const wallEnd = performance.now();
  const cpuAfter = process.cpuUsage(cpuBefore);
  const rssDeltaBytes = raw.peakRss - rssBefore;

  return summarizeRun(
    tabIds.length,
    options,
    raw,
    wallEnd - wallStart,
    cpuAfter,
    rssDeltaBytes,
    percentile,
  );
}

function fmt(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return value.toFixed(digits);
}

function printTable(rows) {
  const columns = [
    { key: "tabsTracked", label: "tabs", width: 5 },
    { key: "roundsRun", label: "rounds", width: 7 },
    { key: "accepted", label: "accepted", width: 9 },
    { key: "failed", label: "failed", width: 7 },
    { key: "rejectedStale", label: "stale-rej", width: 10 },
    { key: "readsPerSecond", label: "reads/s", width: 9, digits: 2 },
    { key: "meanLatencyMs", label: "mean-ms", width: 8 },
    { key: "p95LatencyMs", label: "p95-ms", width: 8 },
    { key: "meanRoundDurationMs", label: "round-ms", width: 9 },
    { key: "estimatedRoundDurationMs", label: "est-round-ms", width: 13 },
    { key: "peakRssDeltaBytesMb", label: "rss-delta-mb", width: 13, digits: 2 },
    { key: "cpuTotalMs", label: "cpu-ms", width: 9 },
  ];

  const header = columns.map((c) => c.label.padStart(c.width)).join(" ");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const row of rows) {
    const derived = {
      ...row,
      peakRssDeltaBytesMb: row.peakRssDeltaBytes / (1024 * 1024),
      cpuTotalMs: row.cpuUserMs + row.cpuSystemMs,
    };
    const line = columns
      .map((c) => {
        const raw = derived[c.key];
        const text = typeof raw === "number" ? fmt(raw, c.digits ?? 0) : String(raw);
        return text.padStart(c.width);
      })
      .join(" ");
    console.log(line);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  console.log("Queue Monitor perf-report (scaling ladder)");
  console.log(
    `counts=${options.counts.join(",")} rounds=${options.rounds} failure-rate=${options.failureRate}`,
  );
  console.log("");
  console.log("=".repeat(78));
  for (const line of CAVEAT_LINES) console.log(line);
  console.log("=".repeat(78));
  console.log("");

  const { mod, cleanup } = await loadRealModules();
  try {
    const rows = [];
    for (const count of options.counts) {
      // eslint-disable-next-line no-await-in-loop
      const row = await runForCount(mod, count, options);
      rows.push(row);
    }

    printTable(rows);

    const resultsDir = resolve(root, "perf-results");
    await mkdir(resultsDir, { recursive: true });
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const outPath = join(resultsDir, `${timestamp}.json`);
    const payload = {
      generatedAt: new Date().toISOString(),
      options,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      caveat: CAVEAT_LINES.join(" "),
      results: rows,
    };
    await writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
    console.log("");
    console.log(`Full run written to ${outPath}`);
    console.log("");
    console.log("Reminder:");
    for (const line of CAVEAT_LINES) console.log(line);
  } finally {
    await cleanup();
  }
}

try {
  await main();
} catch (error) {
  console.error("perf-report failed:", error);
  process.exitCode = 1;
}
