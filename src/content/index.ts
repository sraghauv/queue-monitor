/**
 * Content script entry point. This is the only code that touches a web
 * page, so it is deliberately thin: validate the inbound message, read the
 * live `document`, and respond synchronously. It never reads `input`,
 * `select`, `textarea`, `form`, cookies, or `localStorage`, and never uses
 * `innerHTML` or `eval`.
 */

import { READ_QUEUE } from "../domain/messages.js";
import { readQueue } from "./reader.js";

function isValidRequest(msg: unknown): msg is { type: typeof READ_QUEUE; seq: number } {
  if (typeof msg !== "object" || msg === null) {
    return false;
  }
  const candidate = msg as Record<string, unknown>;
  return (
    candidate["type"] === READ_QUEUE &&
    typeof candidate["seq"] === "number" &&
    Number.isInteger(candidate["seq"]) &&
    candidate["seq"] >= 0
  );
}

// An extension message listener is reachable from other extension contexts,
// so the incoming payload is untrusted shape until validated here.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isValidRequest(message)) {
    return false;
  }

  // Answered synchronously: there is nothing async to do, and returning
  // `true` would keep the port open for a reply that never comes, which is
  // how the background ends up timing out every read.
  sendResponse(readQueue(document, message.seq));
  return false;
});
