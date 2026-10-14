/**
 * The one layer permitted to touch the `chrome` namespace. Every exported
 * function here implements a port from `src/platform/browser.ts` and never
 * throws across that boundary: failures are converted into tagged `AppError`
 * values, per AGENTS.md's "never throw across a port" rule.
 *
 * Only the tabs, storage, and windows APIs are used. No code here reads
 * cookies, page storage, form values, or history, and no code path calls
 * `chrome.tabs.remove` — stop never closes a user's tab.
 */

import type { AppError } from "../domain/errors.js";
import { detailOf } from "../domain/errors.js";
import {
  parseContentReading,
  type ContentReading,
  type ReadQueueRequest,
} from "../domain/messages.js";
import { err, ok, type Result } from "../domain/result.js";
import type { QueueReading, Session } from "../domain/types.js";
import type {
  Clock,
  IdSource,
  Platform,
  StoragePort,
  TabsPort,
  TimerHandle,
  Timers,
} from "./browser.js";
import {
  parseStoredReadings,
  parseStoredSession,
  READINGS_KEY,
  SESSION_KEY,
} from "./storageCodec.js";

/** True for the two rejection messages Chrome uses when a tab can no longer be messaged. */
function isTabMissingError(detail: string): boolean {
  return /receiving end does not exist|no tab with id/iu.test(detail);
}

async function chromeTabsCreate(url: string): Promise<Result<number, AppError>> {
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    if (typeof tab.id !== "number") {
      return err({
        kind: "tab-create-failed",
        opened: 0,
        requested: 1,
        detail: "created tab had no numeric id",
      });
    }
    return ok(tab.id);
  } catch (cause) {
    return err({ kind: "tab-create-failed", opened: 0, requested: 1, detail: detailOf(cause) });
  }
}

/** Sends one READ_QUEUE request. Never rejects: every failure becomes an Err. */
async function sendReadRequest(
  tabId: number,
  request: ReadQueueRequest,
): Promise<Result<ContentReading, AppError>> {
  try {
    const response = await chrome.tabs.sendMessage<ReadQueueRequest, unknown>(tabId, request);
    return parseContentReading(response);
  } catch (cause) {
    const detail = detailOf(cause);
    if (isTabMissingError(detail)) {
      return err({ kind: "tab-missing", tabId });
    }
    return err({ kind: "read-failed", tabId, detail });
  }
}

async function chromeTabsRead(
  tabId: number,
  request: ReadQueueRequest,
  timeoutMs: number,
): Promise<Result<ContentReading, AppError>> {
  let timeoutHandle: TimerHandle | null = null;

  // Raced against a real timer rather than only against chrome's own
  // (unbounded) sendMessage latency: a content script that never answers
  // must not hang a polling round forever.
  const timeoutPromise = new Promise<Result<ContentReading, AppError>>((resolve) => {
    timeoutHandle = systemTimers.schedule(() => {
      resolve(err({ kind: "read-timeout", tabId, timeoutMs }));
    }, timeoutMs);
  });

  // sendReadRequest never rejects, so racing it against timeoutPromise can
  // never produce an unhandled rejection even when the timeout wins first
  // and this side is simply abandoned.
  const sendPromise = sendReadRequest(tabId, request);

  try {
    return await Promise.race([sendPromise, timeoutPromise]);
  } finally {
    // Clear the timer whichever side won. Without this, a tab that answers
    // late (after its own round has already timed out) leaves a dangling
    // scheduled callback behind — at 100 tabs per round that is 100 leaked
    // timers per round.
    if (timeoutHandle !== null) systemTimers.cancel(timeoutHandle);
  }
}

async function chromeTabsListIds(): Promise<readonly number[]> {
  try {
    const tabs = await chrome.tabs.query({});
    return tabs.map((tab) => tab.id).filter((id): id is number => typeof id === "number");
  } catch {
    // An empty array here is indistinguishable from "every tab really is
    // gone" — callers must not treat an empty listIds() result as proof that
    // tracked tabs vanished; it may just mean the query failed.
    return [];
  }
}

/** Best-effort window focus. Never throws: a failure here degrades, it does not fail the command. */
async function focusTabWindow(windowId: number): Promise<void> {
  // chrome.windows needs no extra permission, but defend against it being
  // unavailable in whatever context this runs in: degrade to "tab
  // activated, window not raised" rather than failing the command outright.
  const windowsApi = chrome.windows as typeof chrome.windows | undefined;
  if (windowsApi === undefined || typeof windowsApi.update !== "function") return;
  try {
    await windowsApi.update(windowId, { focused: true });
  } catch {
    // The tab is already active; a window-focus failure is not fatal.
  }
}

async function chromeTabsFocus(tabId: number): Promise<Result<void, AppError>> {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    const windowId = tab?.windowId;
    if (typeof windowId === "number") {
      await focusTabWindow(windowId);
    }
    return ok(undefined);
  } catch (cause) {
    return err({ kind: "focus-failed", tabId, detail: detailOf(cause) });
  }
}

function chromeTabsOnRemoved(listener: (tabId: number) => void): () => void {
  const handler = (tabId: number): void => listener(tabId);
  chrome.tabs.onRemoved.addListener(handler);
  return () => chrome.tabs.onRemoved.removeListener(handler);
}

export function createChromeTabs(): TabsPort {
  return {
    create: chromeTabsCreate,
    read: chromeTabsRead,
    listIds: chromeTabsListIds,
    focus: chromeTabsFocus,
    onRemoved: chromeTabsOnRemoved,
  };
}

/**
 * Picks the storage area for readings fresh on every call rather than once
 * at module load: this is cheap, and it means a context where
 * `chrome.storage.session` becomes available (or stops being) mid-run is
 * picked up immediately instead of being locked in at import time.
 *
 * Readings live in `storage.session` when it exists because they are
 * moment-to-moment progress snapshots that are actively misleading once
 * stale — AGENTS.md forbids ever presenting a stale reading as current, and
 * a reading that survived a full browser restart is exactly that. Falling
 * back to `storage.local` only happens when `storage.session` genuinely
 * isn't available; it is still better than losing the mid-session UI.
 */
function readingsArea(): chrome.storage.StorageArea {
  return chrome.storage.session ?? chrome.storage.local;
}

export function createChromeStorage(): StoragePort {
  return {
    async readSession(): Promise<Result<Session | null, AppError>> {
      try {
        // The session (url, tabIds, state) must survive a service-worker
        // restart so the popup can resume monitoring, so it always lives in
        // the durable `storage.local` area.
        const stored = await chrome.storage.local.get(SESSION_KEY);
        return parseStoredSession(stored[SESSION_KEY]);
      } catch (cause) {
        return err({ kind: "storage-failed", detail: detailOf(cause) });
      }
    },

    async writeSession(session: Session | null): Promise<Result<void, AppError>> {
      try {
        if (session === null) {
          await chrome.storage.local.remove(SESSION_KEY);
        } else {
          await chrome.storage.local.set({ [SESSION_KEY]: session });
        }
        return ok(undefined);
      } catch (cause) {
        return err({ kind: "storage-failed", detail: detailOf(cause) });
      }
    },

    async readReadings(): Promise<Result<readonly QueueReading[], AppError>> {
      try {
        const stored = await readingsArea().get(READINGS_KEY);
        return parseStoredReadings(stored[READINGS_KEY]);
      } catch (cause) {
        return err({ kind: "storage-failed", detail: detailOf(cause) });
      }
    },

    async writeReadings(readings: readonly QueueReading[]): Promise<Result<void, AppError>> {
      try {
        await readingsArea().set({ [READINGS_KEY]: readings });
        return ok(undefined);
      } catch (cause) {
        return err({ kind: "storage-failed", detail: detailOf(cause) });
      }
    },
  };
}

export const systemClock: Clock = {
  now(): number {
    return Date.now();
  },
};

export const systemTimers: Timers = {
  delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  },

  schedule(fn: () => void, ms: number): TimerHandle {
    const id = setTimeout(fn, ms);
    return { id };
  },

  cancel(handle: TimerHandle): void {
    clearTimeout(handle.id as Parameters<typeof clearTimeout>[0]);
  },
};

export const cryptoIds: IdSource = {
  newSessionId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    // Non-crypto fallback, only exercised when crypto.randomUUID is
    // unavailable (e.g. an old Chrome build or a non-secure context).
    // Good enough for a session identifier, not for anything security
    // sensitive.
    return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  },
};

export function createChromePlatform(): Platform {
  return {
    tabs: createChromeTabs(),
    storage: createChromeStorage(),
    clock: systemClock,
    timers: systemTimers,
    ids: cryptoIds,
  };
}
