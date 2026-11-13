#!/usr/bin/env node
// Touchstone tool-image setup.
//
// One reproducible entry point for every Docker image the packs need. A fresh
// clone, a new sandbox, or a machine whose images were pruned can get back to a
// full, working state with one command:
//
//   node spike/scripts/setup.mjs              # pull + build the full default set
//   node spike/scripts/setup.mjs --list       # show the manifest, build nothing
//   node spike/scripts/setup.mjs --dry-run    # show what WOULD run
//   node spike/scripts/setup.mjs --only web,contracts
//   node spike/scripts/setup.mjs --include-optional   # add garak (~3 GB) + observatory, scorecard, legitify, alpine:3.20
//   node spike/scripts/setup.mjs --force      # rebuild/repull even if present
//   node spike/scripts/setup.mjs --daytona    # only the images that reach Daytona
//
// It is idempotent: an image already present is skipped (unless --force). Each
// image is independent, so one failing recipe does not stop the rest; the run
// ends with a summary and a non-zero exit if any required image failed.
//
// The manifest in spike/lib/images.mjs is the single source of truth for image
// recipes; this file is its CLI. The older per-image shell scripts
// (spike/scripts/build-labs.sh, spike/tools/build-*.sh,
// tools/build-aderyn-image.sh) still work and build the same tags, but that
// manifest is the canonical list.
//
// Building needs network (npm/pip/binary fetches). The tool RUNS stay offline;
// only this provisioning step reaches out.

import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------------------------------------------------------------- the manifest
//
// The manifest lives in lib/images.mjs (data only), so the engine can read it
// without loading this CLI. It is re-exported here for the callers that import it
// from this file.

import { MANIFEST } from "../lib/images.mjs";
export { MANIFEST };

// ---------------------------------------------------------------- arg parsing

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
// A value flag takes both forms: `--only=web,contracts` and `--only web,contracts`.
const val = (f) => {
  const a = argv.find((x) => x.startsWith(f + "="));
  if (a) return a.slice(f.length + 1);
  const i = argv.indexOf(f);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};

const opt = {
  list: has("--list"),
  dryRun: has("--dry-run"),
  force: has("--force"),
  includeOptional: has("--include-optional"),
  daytona: has("--daytona"),
  pullOnly: has("--pull-only"),
  buildOnly: has("--build-only"),
  only: (val("--only") || "").split(",").map((s) => s.trim()).filter(Boolean),
  jobs: Math.max(1, parseInt(val("--jobs") || "4", 10) || 4),
};

// Imported (by a test), it only exports MANIFEST. Run, it is the CLI.
const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isCli && (has("--help") || has("-h"))) {
  console.log(`Touchstone tool-image setup

  node spike/scripts/setup.mjs [flags]

Flags:
  --list              Print the manifest and exit (builds nothing)
  --dry-run           Print each action that would run, do nothing
  --force             Rebuild/repull even if the image is already present
  --only a,b          Only these groups (${[...new Set(MANIFEST.map((m) => m.group))].join(", ")})
  --include-optional  Include optional images (garak, observatory, strix, scorecard, legitify, chain-bench, alpine:3.20)
  --daytona           Only images that reach Daytona on main
  --pull-only         Skip builds
  --build-only        Skip pulls
  --jobs N            Concurrent pulls (default 4); builds always run serially
`);
  process.exit(0);
}

// ---------------------------------------------------------------- selection

function selected() {
  let m = MANIFEST.slice();
  if (opt.daytona) m = m.filter((x) => x.daytona);
  if (opt.only.length) m = m.filter((x) => opt.only.includes(x.group));
  if (!opt.includeOptional) m = m.filter((x) => !x.optional);
  if (opt.pullOnly) m = m.filter((x) => x.kind === "pull");
  if (opt.buildOnly) m = m.filter((x) => x.kind === "build");
  return m;
}

// ---------------------------------------------------------------- docker helpers

function run(cmd, args, { capture = false } = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let out = "";
    if (capture) { child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d)); }
    child.on("error", (e) => done({ code: 127, out: out + String(e) }));
    child.on("close", (code) => done({ code, out }));
  });
}

async function present(tag) {
  const r = await run("docker", ["image", "inspect", tag], { capture: true });
  return r.code === 0;
}

function buildArgs(item) {
  const a = ["build"];
  if (item.pullFalse) a.push("--pull=false");
  if (item.file) a.push("-f", item.file);
  a.push("-t", item.tag, item.context);
  return a;
}

// ---------------------------------------------------------------- the run

const results = [];

async function ensure(item) {
  const label = `${item.tag} [${item.group}]`;
  // Pulling `repo:tag@sha256:digest` stores the image ONLY under `repo@sha256:digest`
  // (no short tag is created), which is also the ref the pack code uses. So a pull's
  // presence must be checked by its full ref, not by the short display tag.
  const id = item.kind === "pull" ? item.ref : item.tag;
  if (!opt.force && (await present(id))) {
    results.push({ item, state: "skipped" });
    console.log(`  = ${label} (present)`);
    return;
  }
  if (opt.dryRun) {
    const action = item.kind === "pull" ? `pull ${item.ref}` : `docker ${buildArgs(item).join(" ")}`;
    console.log(`  … would ${action}`);
    results.push({ item, state: "dry" });
    return;
  }
  console.log(`  → ${item.kind === "pull" ? "pulling" : "building"} ${label}`);
  let r;
  if (item.kind === "pull") {
    r = await run("docker", ["pull", item.ref], { capture: true });
  } else {
    if (item.base) {
      const br = await run("docker", ["pull", item.base], { capture: true });
      if (br.code !== 0) {
        results.push({ item, state: "failed", why: `base pull failed: ${br.out.trim().split("\n").slice(-3).join(" ")}` });
        console.log(`  ✗ ${label} (base pull failed)`);
        return;
      }
    }
    r = await run("docker", buildArgs(item), { capture: true });
  }
  // A pull by digest stores the image under `repo@sha256:…` only. Give it its
  // short tag too (`alpine:3.20`), so a check by tag finds it, but never move
  // a tag that already exists: that one may name another image.
  if (r.code === 0 && item.kind === "pull" && item.ref !== item.tag && /:[^/]+$/.test(item.tag) && !(await present(item.tag))) {
    const t = await run("docker", ["tag", item.ref, item.tag], { capture: true });
    if (t.code !== 0) r = { code: t.code, out: `pulled, but docker tag ${item.tag} failed: ${t.out}` };
  }
  if (r.code === 0) {
    results.push({ item, state: item.kind === "pull" ? "pulled" : "built" });
    console.log(`  ✓ ${label}`);
  } else {
    results.push({ item, state: "failed", why: r.out.trim().split("\n").slice(-4).join("\n      ") });
    console.log(`  ✗ ${label}`);
  }
}

async function pool(items, n, fn) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

async function main() {
  const items = selected();

  if (opt.list) {
    for (const g of [...new Set(items.map((x) => x.group))]) {
      console.log(`\n${g}`);
      for (const x of items.filter((y) => y.group === g)) {
        console.log(`  ${x.kind === "pull" ? "pull " : "build"} ${x.tag}${x.optional ? "  (optional)" : ""}${x.daytona ? "  (daytona)" : ""}`);
      }
    }
    console.log(`\n${items.length} images.`);
    return;
  }

  console.log(`Touchstone setup: ${items.length} images selected${opt.force ? " (force)" : ""}${opt.dryRun ? " (dry run)" : ""}.\n`);

  // Pulls first, concurrently (network-bound); builds after, serially (CPU/IO-heavy).
  const pulls = items.filter((x) => x.kind === "pull");
  const builds = items.filter((x) => x.kind === "build");

  if (pulls.length) { console.log(`Pulls (${pulls.length}, up to ${opt.jobs} at once):`); await pool(pulls, opt.jobs, ensure); }
  if (builds.length) { console.log(`\nBuilds (${builds.length}, serial):`); for (const b of builds) await ensure(b); }

  // summary
  const by = (s) => results.filter((r) => r.state === s);
  console.log(`\n──────── summary ────────`);
  console.log(`built:   ${by("built").length}`);
  console.log(`pulled:  ${by("pulled").length}`);
  console.log(`skipped: ${by("skipped").length} (already present)`);
  const failed = by("failed");
  console.log(`failed:  ${failed.length}`);
  for (const f of failed) console.log(`\n  ✗ ${f.item.tag}\n      ${f.why}`);
  process.exit(failed.length ? 1 : 0);
}

if (isCli) main();
