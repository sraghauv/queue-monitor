#!/usr/bin/env node
/**
 * Enforces the dependency-direction and containment rules from AGENTS.md's
 * "Architecture" and "Correctness Rules" sections.
 *
 * IMPORTANT — this is a LEXICAL check, not a type-aware one. It extracts
 * import/export specifiers and a few forbidden identifiers with regexes
 * over the raw source text, after stripping out comments and string/
 * template literals so that mentions inside documentation or sample code
 * don't produce false positives. It does not parse the TypeScript AST, does
 * not resolve module graphs beyond the specifier text, and does not
 * understand re-exports, barrel files, or conditional/computed imports. A
 * sufficiently obfuscated import (built from concatenated strings, read
 * from a variable, etc.) can evade it. Its guarantee is therefore: "no
 * *lexically visible* violation of these rules exists in src/", not "no
 * violation can possibly exist." That is an acceptable trade-off for a
 * zero-dependency lint step that runs on every commit — it catches the
 * common, honest mistakes (a stray `chrome.` call, a missing `.js`
 * extension, an app module reaching into the concrete adapter) without
 * requiring a full TypeScript compiler in the loop.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

/** @typedef {{ path: string, line: number, rule: string, detail: string }} Violation */

/** Layers in precedence order; first path-prefix match wins. */
const LAYER_RULES = [
  { prefix: "src/domain/", layer: "domain" },
  { prefix: "src/config/", layer: "config" },
  { prefix: "src/platform/", layer: "platform" },
  { prefix: "src/app/", layer: "app" },
  { prefix: "src/background/", layer: "entry" },
  { prefix: "src/popup/", layer: "entry" },
  { prefix: "src/content/", layer: "entry" },
];

/** Allowed outbound edges per layer, per AGENTS.md's "Architecture" section. */
const ALLOWED_EDGES = {
  domain: new Set(["domain", "config"]),
  config: new Set(["config"]),
  platform: new Set(["platform", "domain", "config"]),
  app: new Set(["app", "platform", "domain", "config"]),
  // entry may import anything
  entry: null,
};

const ENTRY_FILES_ALLOWED_CHROME = new Set([
  "src/background/index.ts",
  "src/popup/index.ts",
  "src/content/index.ts",
]);

const FORBIDDEN_DOM_PATTERNS = [
  { re: /\binnerHTML\b/u, name: "innerHTML" },
  { re: /\bouterHTML\b/u, name: "outerHTML" },
  { re: /\binsertAdjacentHTML\b/u, name: "insertAdjacentHTML" },
  { re: /\beval\s*\(/u, name: "eval(" },
  { re: /\bnew\s+Function\s*\(/u, name: "new Function(" },
];

/**
 * Strip line comments, block comments, and string/template literals from
 * TypeScript source, replacing the removed spans with spaces so that line
 * numbers and column offsets of the surviving code are preserved. This is
 * a small hand-rolled scanner rather than a single regex because quotes,
 * comment markers, and escapes can appear inside each other (e.g. a string
 * containing `//`, or a comment containing an unbalanced quote), and a
 * single regex pass handles that unreliably.
 *
 * @param {string} source
 * @returns {string}
 */
function stripCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const two = source.slice(i, i + 2);
    const ch = source[i];

    if (two === "//") {
      let j = i + 2;
      while (j < n && source[j] !== "\n") j++;
      out += " ".repeat(j - i);
      i = j;
      continue;
    }

    if (two === "/*") {
      let j = i + 2;
      while (j < n && source.slice(j, j + 2) !== "*/") j++;
      j = Math.min(j + 2, n);
      for (let k = i; k < j; k++) out += source[k] === "\n" ? "\n" : " ";
      i = j;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      for (let k = i; k < j; k++) out += source[k] === "\n" ? "\n" : " ";
      i = j;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Extract {specifier, line} pairs for import/export/dynamic-import
 * statements. Operates on the original source for the string contents, but
 * uses the stripped source to confirm each match site isn't itself inside
 * a comment (a commented-out import would otherwise still match the
 * regex against the original text).
 *
 * @param {string} original
 * @param {string} stripped
 * @returns {{ specifier: string, line: number }[]}
 */
function extractImportSpecifiers(original, stripped) {
  const results = [];
  const patterns = [
    /import\s+[^;]*?\bfrom\s*["']([^"']+)["']/gu,
    /import\s*["']([^"']+)["']\s*;/gu,
    /export\s+[^;]*?\bfrom\s*["']([^"']+)["']/gu,
    /import\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];

  for (const pattern of patterns) {
    for (const match of original.matchAll(pattern)) {
      const index = match.index ?? 0;
      const strippedSlice = stripped.slice(index, index + match[0].length);
      const keyword = match[0].split(/\s/u)[0];
      // Confirm the statement keyword at the match start is not blanked out
      // in the stripped text, i.e. it's not inside a comment or string.
      if (!strippedSlice.includes(keyword)) {
        continue;
      }
      const line = original.slice(0, index).split("\n").length;
      results.push({ specifier: match[1], line });
    }
  }
  return results;
}

/**
 * @param {string} relPath path relative to repo root, e.g. "src/app/poller.ts"
 * @returns {string | null}
 */
function layerOf(relPath) {
  for (const { prefix, layer } of LAYER_RULES) {
    if (relPath.startsWith(prefix)) return layer;
  }
  return null;
}

/**
 * Resolve a relative specifier against the importing file's directory to a
 * repo-relative path, for layer classification. Returns null for bare
 * (package) specifiers, which are not subject to the layer graph.
 *
 * @param {string} relPath
 * @param {string} specifier
 * @returns {string | null}
 */
function resolveRelativeSpecifier(relPath, specifier) {
  if (!specifier.startsWith(".")) return null;
  const dir = path.dirname(relPath);
  const resolved = path.posix.normalize(path.posix.join(dir, specifier));
  return resolved;
}

async function collectTsFiles(dir) {
  /** @type {string[]} */
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Rules 2, 4, and 5: per-line checks on the stripped (comment/string-free)
 * text — forbidden DOM/eval sinks, the chrome.tabs.remove ban, and chrome
 * namespace containment.
 *
 * @param {string} relPath
 * @param {string} stripped
 * @param {Violation[]} violations
 */
function checkLinePatterns(relPath, stripped, violations) {
  const isPlatform = relPath.startsWith("src/platform/");
  const isAllowedEntry = ENTRY_FILES_ALLOWED_CHROME.has(relPath);
  const strippedLines = stripped.split("\n");

  for (let lineNo = 0; lineNo < strippedLines.length; lineNo++) {
    const lineText = strippedLines[lineNo] ?? "";

    for (const { re, name } of FORBIDDEN_DOM_PATTERNS) {
      if (re.test(lineText)) {
        violations.push({
          path: relPath,
          line: lineNo + 1,
          rule: "no-unsafe-dom-or-eval",
          detail: `uses ${name}, which AGENTS.md forbids in favor of textContent rendering`,
        });
      }
    }

    if (/\bchrome\.tabs\.remove\b/u.test(lineText)) {
      violations.push({
        path: relPath,
        line: lineNo + 1,
        rule: "no-tab-close",
        detail: "calls chrome.tabs.remove; stop must never close a user's tab",
      });
    }

    if (/\bchrome\./u.test(lineText) && !isPlatform && !isAllowedEntry) {
      violations.push({
        path: relPath,
        line: lineNo + 1,
        rule: "chrome-containment",
        detail:
          "references the chrome namespace outside src/platform/** and the three entry files; only platform adapters and background/popup/content index.ts may touch chrome",
      });
    }
  }
}

/**
 * Rules 1, 3, and 6: checks driven by each import specifier — required
 * .js extension, the app-layer ban on the concrete chrome adapter, and the
 * inward-dependency layer graph.
 *
 * @param {string} relPath
 * @param {string | null} myLayer
 * @param {{ specifier: string, line: number }[]} imports
 * @param {Violation[]} violations
 */
function checkRequireJsAndAdapterRules(relPath, myLayer, imports, violations) {
  for (const { specifier, line } of imports) {
    if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
      violations.push({
        path: relPath,
        line,
        rule: "require-js-extension",
        detail: `relative import "${specifier}" must end in .js (tsconfig requires explicit extensions for bundler resolution)`,
      });
    }

    if (myLayer !== "app" || !specifier.startsWith(".")) {
      continue;
    }
    const resolved = resolveRelativeSpecifier(relPath, specifier);
    if (resolved !== null && /(^|\/)platform\/chromeBrowser(\.js)?$/u.test(resolved)) {
      violations.push({
        path: relPath,
        line,
        rule: "app-no-concrete-adapter",
        detail: `imports "${specifier}" (platform/chromeBrowser); src/app/** must depend on the ports in platform/browser.ts, not the concrete chrome implementation`,
      });
    }
  }
}

function checkLayerGraph(relPath, myLayer, imports, violations) {
  if (myLayer === null) {
    return;
  }
  const allowed = ALLOWED_EDGES[myLayer];
  if (allowed === null) {
    return;
  }
  for (const { specifier, line } of imports) {
    if (!specifier.startsWith(".")) {
      continue;
    }
    const resolved = resolveRelativeSpecifier(relPath, specifier);
    if (resolved === null || !resolved.startsWith("src/")) {
      continue;
    }
    const targetLayer = layerOf(resolved);
    if (targetLayer !== null && !allowed.has(targetLayer)) {
      violations.push({
        path: relPath,
        line,
        rule: "layer-graph",
        detail: `layer "${myLayer}" imports "${specifier}" (layer "${targetLayer}"); AGENTS.md only allows ${myLayer} -> {${[...allowed].join(", ")}}`,
      });
    }
  }
}

function checkImportRules(relPath, myLayer, imports, violations) {
  checkRequireJsAndAdapterRules(relPath, myLayer, imports, violations);
  checkLayerGraph(relPath, myLayer, imports, violations);
}

/**
 * @param {string} absPath
 * @param {Violation[]} violations
 */
async function checkFile(absPath, violations) {
  const relPath = path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
  const original = await readFile(absPath, "utf8");
  const stripped = stripCommentsAndStrings(original);
  const myLayer = layerOf(relPath);

  // Rules 2, 4, 5 run on the stripped text so comments/strings mentioning
  // these tokens don't trigger false positives.
  checkLinePatterns(relPath, stripped, violations);

  // Rules 1, 3, 6 run on specifiers extracted from the original text, but
  // extractImportSpecifiers() already discards matches that land inside
  // comments or strings using the stripped text internally.
  const imports = extractImportSpecifiers(original, stripped);
  checkImportRules(relPath, myLayer, imports, violations);
}

async function main() {
  const files = await collectTsFiles(SRC_ROOT);
  /** @type {Violation[]} */
  const violations = [];

  for (const absPath of files) {
    await checkFile(absPath, violations);
  }

  violations.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path)));

  for (const v of violations) {
    console.log(`${v.path}:${v.line}  ${v.rule}  ${v.detail}`);
  }

  if (violations.length > 0) {
    console.log(`\n${violations.length} module boundary violation(s) found.`);
    process.exitCode = 1;
  } else {
    console.log(`Module boundary check passed: ${files.length} file(s) checked.`);
  }
}

await main();
