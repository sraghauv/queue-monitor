/**
 * Coordinator state and its persistence rules.
 *
 * Separated from the command handlers so the rules about *when* state is
 * written and reconciled can be read on their own. Everything here is shared
 * mutable state deliberately held in exactly one place: the failure this design
 * exists to prevent is the popup and the background each keeping their own idea
 * of the session.
 */

import type { AllowlistConfig } from "../config/allowlist.js";
import { DEFAULT_ALLOWLIST } from "../config/allowlist.js";
import { describeError, type AppError } from "../domain/errors.js";
import { STALE_AFTER_MS } from "../domain/readings.js";
import { err, type Result } from "../domain/result.js";
import {
  EMPTY_METRICS,
  type Metrics,
  type QueueReading,
  type Session,
  type Snapshot,
} from "../domain/types.js";
import type { Clock, TabsPort } from "../platform/browser.js";
import type { Poller } from "./poller.js";
import { projectSnapshot } from "./snapshot.js";
import type { Store } from "./store.js";

export type CoordinatorDeps = {
  store: Store;
  poller: Poller;
  tabs: TabsPort;
  clock: Clock;
  newSessionId: () => string;
  allowlist?: AllowlistConfig;
  staleAfterMs?: number;
};

export type Mutable = {
  session: Session | null;
  readings: readonly QueueReading[];
  metrics: Metrics;
  lastError: string | null;
  hydrated: boolean;
};

export type Context = {
  readonly state: Mutable;
  readonly deps: CoordinatorDeps;
  readonly allowlist: AllowlistConfig;
  readonly staleAfterMs: number;
};

export function createContext(deps: CoordinatorDeps): Context {
  return {
    state: {
      session: null,
      readings: [],
      metrics: EMPTY_METRICS,
      lastError: null,
      hydrated: false,
    },
    deps,
    allowlist: deps.allowlist ?? DEFAULT_ALLOWLIST,
    staleAfterMs: deps.staleAfterMs ?? STALE_AFTER_MS,
  };
}

export function buildSnapshot(ctx: Context): Snapshot {
  return projectSnapshot({ ...ctx.state, now: ctx.deps.clock.now() });
}

/** Records the failure for the UI and returns it, so no caller can drop it. */
export function fail(ctx: Context, error: AppError): Result<Snapshot, AppError> {
  ctx.state.lastError = describeError(error);
  return err(error);
}

export async function persist(ctx: Context): Promise<void> {
  const result = await ctx.deps.store.save(ctx.state.session, ctx.state.readings);
  if (!result.ok) ctx.state.lastError = describeError(result.error);
}

/**
 * Reconciles tracked tabs against the browser, then persists. Runs on hydrate
 * and after any tab closure: a worker that slept through three tab closures
 * must not go on reporting those tabs as live.
 */
export async function reconcileAndPersist(ctx: Context): Promise<void> {
  const result = await ctx.deps.store.reconcile(ctx.state.session, ctx.state.readings);
  ctx.state.session = result.session;
  ctx.state.readings = result.readings;
  await persist(ctx);
}

/**
 * Loads persisted state exactly once per worker lifetime. A restarted service
 * worker has empty globals, so every entry point calls this before touching
 * state rather than assuming the previous instance's memory survived.
 */
export async function ensureHydrated(ctx: Context): Promise<void> {
  if (ctx.state.hydrated) return;
  ctx.state.hydrated = true;
  const loaded = await ctx.deps.store.load();
  ctx.state.session = loaded.session;
  ctx.state.readings = loaded.readings;
  const firstProblem = loaded.problems[0];
  if (firstProblem) ctx.state.lastError = describeError(firstProblem);
  await reconcileAndPersist(ctx);
}
