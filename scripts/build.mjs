/**
 * Bundles the extension into `dist/`. Output paths must match the names in
 * `extension/manifest.json`; the check below fails the build when they drift.
 */

import { build, context } from "esbuild";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outdir = resolve(root, "dist");
const watch = process.argv.includes("--watch");

const entries = [
  { in: "src/background/index.ts", out: "background", format: "esm" },
  { in: "src/content/index.ts", out: "content", format: "iife" },
  { in: "src/popup/index.ts", out: "popup", format: "esm" },
];

async function manifestReferences() {
  const manifest = JSON.parse(await readFile(resolve(root, "extension/manifest.json"), "utf8"));
  const referenced = new Set([manifest.background.service_worker]);
  for (const script of manifest.content_scripts ?? []) {
    for (const file of script.js ?? []) referenced.add(file);
  }
  referenced.add(manifest.action.default_popup);
  return referenced;
}

async function copyStatic() {
  const staticDir = resolve(root, "extension");
  for (const name of await readdir(staticDir)) {
    await cp(resolve(staticDir, name), resolve(outdir, name));
  }
}

async function verifyOutputs() {
  const referenced = await manifestReferences();
  const produced = new Set(await readdir(outdir));
  const missing = [...referenced].filter((file) => !produced.has(file));
  if (missing.length > 0) {
    throw new Error(`manifest.json references files the build did not emit: ${missing.join(", ")}`);
  }
}

const options = (entry) => ({
  entryPoints: [resolve(root, entry.in)],
  outfile: resolve(outdir, `${entry.out}.js`),
  bundle: true,
  format: entry.format,
  target: "chrome116",
  platform: "browser",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  legalComments: "none",
  logLevel: "info",
});

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

if (watch) {
  for (const entry of entries) {
    const ctx = await context(options(entry));
    await ctx.watch();
  }
  await copyStatic();
  console.log("watching; dist/ rebuilds on change");
} else {
  await Promise.all(entries.map((entry) => build(options(entry))));
  await copyStatic();
  await verifyOutputs();
  console.log(`built ${entries.length} bundles into dist/`);
}
