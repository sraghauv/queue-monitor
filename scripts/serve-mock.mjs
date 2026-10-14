#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, normalize } from "node:path";

const MOCK_QUEUE_DIR = normalize(resolve(import.meta.dirname, "../mock-queue"));

// Get port from environment or command line
let port = 8787;
if (process.env.PORT) {
  port = Math.trunc(Number(process.env.PORT));
}
const portIndex = process.argv.indexOf("--port");
if (portIndex !== -1 && process.argv[portIndex + 1]) {
  port = Math.trunc(Number(process.argv[portIndex + 1]));
}

// Map file extensions to MIME types
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function getMimeType(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return mimeTypes[ext] || "application/octet-stream";
}

function respondError(res, status, message) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`${status} ${message}\n`);
}

function resolveFilePath(urlPath) {
  try {
    return normalize(resolve(MOCK_QUEUE_DIR, "." + urlPath));
  } catch {
    return null;
  }
}

async function serveFile(res, filePath, method) {
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": getMimeType(filePath),
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Content-Length": content.length,
    });
    if (method === "GET") {
      res.end(content);
    } else {
      res.end();
    }
  } catch {
    respondError(res, 404, "Not Found");
  }
}

// Create the server
const server = createServer(async (req, res) => {
  // Only allow GET and HEAD
  if (req.method !== "GET" && req.method !== "HEAD") {
    respondError(res, 405, "Method Not Allowed");
    return;
  }

  // Get the path from the request (without query string).
  const rawPath = req.url.split("?")[0];

  // Percent-decode BEFORE any traversal check. Checking the raw path first
  // would miss `%2e%2e`, leaving the containment check below as the only
  // defense; decoding here means both checks see the same path the filesystem
  // will see. A malformed escape is rejected rather than passed through.
  let urlPath;
  try {
    urlPath = decodeURIComponent(rawPath);
  } catch {
    respondError(res, 400, "Bad Request");
    return;
  }

  // Reject traversal segments and NUL bytes outright.
  if (urlPath.includes("..") || urlPath.includes("\0")) {
    respondError(res, 403, "Forbidden");
    return;
  }

  // Resolve the file path
  let filePath = resolveFilePath(urlPath);
  if (filePath === null) {
    respondError(res, 400, "Bad Request");
    return;
  }

  // Double-check: ensure the resolved path is within mock-queue directory
  if (!filePath.startsWith(MOCK_QUEUE_DIR + "/") && filePath !== MOCK_QUEUE_DIR) {
    respondError(res, 403, "Forbidden");
    return;
  }

  // If requesting a directory, serve index.html
  if (urlPath === "/" || urlPath === "") {
    filePath = resolve(MOCK_QUEUE_DIR, "index.html");
  }

  await serveFile(res, filePath, req.method);
});

// Bind to 127.0.0.1 only; never 0.0.0.0 to keep this fixture unreachable from the network
server.listen(port, "127.0.0.1", () => {
  console.log(`\nQueue Monitor test fixture serving at http://127.0.0.1:${port}/`);
  console.log(`\nNote: http://127.0.0.1 is the only host in the extension's shipped allowlist.`);
  console.log(`Use this URL for manual testing and to verify the content script works.\n`);
});
