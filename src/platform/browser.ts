/**
 * Ports to the browser. Application code depends on these interfaces only, so
 * every workflow is testable against fakes and no domain module imports the
 * `chrome` namespace.
 */

import type { AppError } from "../domain/errors.js";
import type { Result } from "../domain/result.js";
import type { ContentReading, ReadQueueRequest } from "../domain/messages.js";
import type { QueueReading, Session } from "../domain/types.js";

export type TabsPort = {
  /** Opens one background tab. Resolves to its numeric id. */
  create(url: string): Promise<Result<number, AppError>>;
  /**
   * Asks one tab for a reading. Implementations must enforce `timeoutMs` and
   * convert every failure into a tagged error — never a thrown value.
   */
  read(
    tabId: number,
    request: ReadQueueRequest,
    timeoutMs: number,
  ): Promise<Result<ContentReading, AppError>>;
  /** Ids of all tabs currently open in the browser. */
  listIds(): Promise<readonly number[]>;
  /** Activates the tab and focuses its window. */
  focus(tabId: number): Promise<Result<void, AppError>>;
  /** Subscribes to tab closure. Returns an unsubscribe function. */
  onRemoved(listener: (tabId: number) => void): () => void;
};

export type StoragePort = {
  readSession(): Promise<Result<Session | null, AppError>>;
  writeSession(session: Session | null): Promise<Result<void, AppError>>;
  readReadings(): Promise<Result<readonly QueueReading[], AppError>>;
  writeReadings(readings: readonly QueueReading[]): Promise<Result<void, AppError>>;
};

export type Clock = {
  now(): number;
};

export type TimerHandle = { readonly id: unknown };

export type Timers = {
  delay(ms: number): Promise<void>;
  schedule(fn: () => void, ms: number): TimerHandle;
  cancel(handle: TimerHandle): void;
};

export type IdSource = {
  /** Session identifier. Must be unguessable enough to avoid collisions. */
  newSessionId(): string;
};

export type Platform = {
  readonly tabs: TabsPort;
  readonly storage: StoragePort;
  readonly clock: Clock;
  readonly timers: Timers;
  readonly ids: IdSource;
};
