/**
 * The single owner of session state.
 *
 * Every command — from the popup, from a tab-closure event, from a service
 * worker that just restarted — funnels through here, because the one thing
 * that must never happen is the popup and the background mutating the same
 * session independently.
 *
 * State and persistence live in `coordinatorState.ts`; this module is the
 * command surface.
 */

import type { AppError } from "../domain/errors.js";
import { describeError } from "../domain/errors.js";
import type { PopupCommand } from "../domain/messages.js";
import { latestByTab } from "../domain/readings.js";
import { ok, type Result } from "../domain/result.js";
import {
  applyCommand,
  createSession,
  isActive,
  removeTabIds,
  withSeq,
  withTabIds,
} from "../domain/session.js";
import { EMPTY_METRICS, type Snapshot } from "../domain/types.js";
import { validateTarget } from "../domain/validation.js";
import {
  buildSnapshot,
  createContext,
  ensureHydrated,
  fail,
  persist,
  reconcileAndPersist,
  type Context,
  type CoordinatorDeps,
} from "./coordinatorState.js";
import { computeMetrics } from "./metrics.js";

export type { CoordinatorDeps };

export type Coordinator = {
  /** Loads persisted state and reconciles it against the real browser tabs. */
  hydrate(): Promise<Snapshot>;
  handle(command: PopupCommand): Promise<Result<Snapshot, AppError>>;
  /** Runs one polling round, but only while the session is monitoring. */
  tick(): Promise<Snapshot>;
  snapshot(): Snapshot;
  /** Reacts to a tab the user closed. */
  noteTabClosed(tabId: number): Promise<void>;
  /** True when the caller's round loop should keep going. */
  shouldPoll(): boolean;
};

/**
 * Opens tabs one at a time, persisting as each id arrives, so a worker that
 * dies midway leaves a session that still knows about the tabs it did open.
 */
async function openTabs(ctx: Context, url: string, count: number): Promise<AppError | null> {
  for (let opened = 0; opened < count; opened += 1) {
    const created = await ctx.deps.tabs.create(url);
    const current = ctx.state.session;
    if (!current) return { kind: "no-session" };
    if (!created.ok) {
      // Partial success is reported as partial, never rounded up to success.
      await persist(ctx);
      return {
        kind: "tab-create-failed",
        opened: current.tabIds.length,
        requested: count,
        detail: describeError(created.error),
      };
    }
    ctx.state.session = withTabIds(
      current,
      [...current.tabIds, created.value],
      ctx.deps.clock.now(),
    );
    await persist(ctx);
  }
  return null;
}

async function start(
  ctx: Context,
  url: string,
  count: number,
): Promise<Result<Snapshot, AppError>> {
  // Revalidated here even though the popup checks too: the popup is not the
  // security boundary, and a command can arrive from any extension context.
  const target = validateTarget(url, count, ctx.allowlist);
  if (!target.ok) return fail(ctx, target.error);

  const existing = ctx.state.session;
  if (existing && isActive(existing)) {
    // Never automatically create a second set of tabs for a live session.
    return fail(ctx, { kind: "invalid-transition", from: existing.state, command: "START" });
  }

  ctx.state.session = createSession({
    id: ctx.deps.newSessionId(),
    url: target.value.url.href,
    requestedCount: target.value.count,
    now: ctx.deps.clock.now(),
  });
  ctx.state.readings = [];
  ctx.state.metrics = EMPTY_METRICS;
  ctx.state.lastError = null;
  await persist(ctx);

  const openFailure = await openTabs(ctx, target.value.url.href, target.value.count);
  if (openFailure) return fail(ctx, openFailure);

  const opened = ctx.state.session;
  if (!opened) return fail(ctx, { kind: "no-session" });
  const activated = applyCommand(opened, "ACTIVATE", ctx.deps.clock.now());
  if (!activated.ok) return fail(ctx, activated.error);
  ctx.state.session = activated.value;
  await persist(ctx);
  return ok(buildSnapshot(ctx));
}

async function transition(
  ctx: Context,
  command: "PAUSE" | "RESUME" | "STOP",
): Promise<Result<Snapshot, AppError>> {
  if (!ctx.state.session) return fail(ctx, { kind: "no-session" });
  if (command === "RESUME") {
    // Recheck that tracked tabs still exist before resuming.
    await reconcileAndPersist(ctx);
  }
  const current = ctx.state.session;
  if (!current) return fail(ctx, { kind: "no-session" });

  const moved = applyCommand(current, command, ctx.deps.clock.now());
  if (!moved.ok) return fail(ctx, moved.error);
  ctx.state.session = moved.value;
  ctx.state.lastError = null;
  await persist(ctx);
  return ok(buildSnapshot(ctx));
}

async function focusTab(ctx: Context, tabId: number): Promise<Result<Snapshot, AppError>> {
  const current = ctx.state.session;
  if (!current) return fail(ctx, { kind: "no-session" });
  if (!current.tabIds.includes(tabId)) return fail(ctx, { kind: "tab-missing", tabId });

  // Pause before focusing: a tab the user is now watching should not be
  // competing with a polling round for the same message channel.
  if (current.state === "monitoring" || current.state === "starting") {
    const paused = applyCommand(current, "PAUSE", ctx.deps.clock.now());
    if (paused.ok) {
      ctx.state.session = paused.value;
      await persist(ctx);
    }
  }
  const focused = await ctx.deps.tabs.focus(tabId);
  if (!focused.ok) return fail(ctx, focused.error);
  ctx.state.lastError = null;
  return ok(buildSnapshot(ctx));
}

async function runTick(ctx: Context): Promise<Snapshot> {
  const current = ctx.state.session;
  if (!current || current.state !== "monitoring") return buildSnapshot(ctx);

  const round = await ctx.deps.poller.runRound({
    tabIds: current.tabIds,
    prior: ctx.state.readings,
    seq: current.seq,
  });
  ctx.state.readings = [...latestByTab(round.readings).values()];
  // The session may have changed while the round was in flight (a closed tab,
  // a pause); re-read it rather than writing back the pre-round copy.
  const after = ctx.state.session;
  if (after) ctx.state.session = withSeq(after, round.nextSeq, ctx.deps.clock.now());
  ctx.state.metrics = computeMetrics({
    round,
    readings: ctx.state.readings,
    now: ctx.deps.clock.now(),
    previous: ctx.state.metrics,
    staleAfterMs: ctx.staleAfterMs,
  });
  await persist(ctx);
  return buildSnapshot(ctx);
}

function dispatch(ctx: Context, command: PopupCommand): Promise<Result<Snapshot, AppError>> {
  switch (command.type) {
    case "START":
      return start(ctx, command.url, command.count);
    case "PAUSE":
      return transition(ctx, "PAUSE");
    case "RESUME":
      return transition(ctx, "RESUME");
    case "STOP":
      // Stop sets state and leaves every tab open, by design.
      return transition(ctx, "STOP");
    case "FOCUS_TAB":
      return focusTab(ctx, command.tabId);
    case "GET_SNAPSHOT":
      return Promise.resolve(ok(buildSnapshot(ctx)));
  }
}

export function createCoordinator(deps: CoordinatorDeps): Coordinator {
  const ctx = createContext(deps);

  return {
    async hydrate(): Promise<Snapshot> {
      await ensureHydrated(ctx);
      return buildSnapshot(ctx);
    },

    async handle(command: PopupCommand): Promise<Result<Snapshot, AppError>> {
      await ensureHydrated(ctx);
      return dispatch(ctx, command);
    },

    async tick(): Promise<Snapshot> {
      await ensureHydrated(ctx);
      return runTick(ctx);
    },

    snapshot(): Snapshot {
      return buildSnapshot(ctx);
    },

    async noteTabClosed(tabId: number): Promise<void> {
      await ensureHydrated(ctx);
      const current = ctx.state.session;
      if (!current || !current.tabIds.includes(tabId)) return;
      ctx.state.session = removeTabIds(current, [tabId], ctx.deps.clock.now());
      await reconcileAndPersist(ctx);
    },

    shouldPoll(): boolean {
      return ctx.state.session?.state === "monitoring";
    },
  };
}
