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
//   node spike/scripts/setup.mjs --include-optional   # add garak (~3 GB) + observatory
//   node spike/scripts/setup.mjs --force      # rebuild/repull even if present
//   node spike/scripts/setup.mjs --daytona    # only the images that reach Daytona
//
// It is idempotent: an image already present is skipped (unless --force). Each
// image is independent, so one failing recipe does not stop the rest; the run
// ends with a summary and a non-zero exit if any required image failed.
//
// This file is the single source of truth for image recipes. The older per-image
// shell scripts (spike/scripts/build-labs.sh, spike/tools/build-*.sh,
// tools/build-aderyn-image.sh) still work and build the same tags, but this
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
// kind "pull": `ref` is the exact image reference the pack code uses (pinned by
//   digest where the code pins it). We pull that ref; `tag` is what we inspect.
// kind "build": `file` (optional -f Dockerfile) and `context` (build context,
//   relative to repo root). `base` (optional) is a public image pulled first for
//   a build that uses --pull=false.
//
// group = the pack the image belongs to. optional = heavy / rarely needed.
// daytona = true for the images that reach a Daytona sandbox on main today.

export const MANIFEST = [
  // ---- contracts (EVM static/dynamic analysis + proof replay) ----
  { tag: "ghcr.io/foundry-rs/foundry:latest", group: "contracts", kind: "pull",
    ref: "ghcr.io/foundry-rs/foundry:latest", daytona: true,
    note: "forge, anvil, solc install, proof replay. Moving tag — not digest-pinned upstream." },
  { tag: "ghcr.io/trailofbits/eth-security-toolbox:nightly", group: "contracts", kind: "pull",
    ref: "ghcr.io/trailofbits/eth-security-toolbox:nightly", daytona: true,
    note: "Slither, Echidna, Medusa. Moving tag." },
  { tag: "touchstone/mythril:0.24.8", group: "contracts", kind: "build",
    file: "spike/packs/contracts/Dockerfile.mythril", context: "spike/packs/contracts", daytona: true },
  { tag: "touchstone/heimdall:0.9.3", group: "contracts", kind: "build",
    file: "spike/packs/contracts/Dockerfile.heimdall", context: "spike/packs/contracts", daytona: true },
  { tag: "touchstone/aderyn:0.6.8", group: "contracts", kind: "build",
    context: "tools/aderyn", daytona: true },
  { tag: "touchstone/halmos:0.3.3", group: "contracts", kind: "build",
    file: "spike/packs/contracts/images/Dockerfile.halmos", context: "spike/packs/contracts/images",
    note: "Halmos pre-pass; same build as images/build.sh halmos." },
  { tag: "touchstone/chimera:e2.3.3-m1.5.1", group: "contracts", kind: "build",
    file: "spike/packs/contracts/images/Dockerfile.chimera", context: "spike/packs/contracts/images",
    note: "Chimera pre-pass (Echidna + Medusa); same build as images/build.sh chimera." },

  // ---- keys (Safe / signing) ----
  { tag: "touchstone-chain-tools:wave1", group: "keys", kind: "build",
    file: "spike/packs/keys/runtime/Dockerfile", context: ".", daytona: true,
    note: "Shared lab world for keys and chain-watch. Context is the repo root." },
  { tag: "touchstone/safe-hash:0.0.19", group: "keys", kind: "build",
    file: "spike/packs/keys/safe-hash/Dockerfile", context: "spike/packs/keys/safe-hash" },
  { tag: "touchstone/safe-tx-hashes:e295975", group: "keys", kind: "build",
    file: "spike/packs/keys/safe-tx-hashes/Dockerfile", context: "spike/packs/keys/safe-tx-hashes" },

  // ---- chain-watch ----
  { tag: "touchstone/slither:0.11.6", group: "chain-watch", kind: "build",
    context: "spike/packs/chain-watch/slither", daytona: true },
  { tag: "touchstone/oz-monitor:1.7.0", group: "chain-watch", kind: "build",
    context: "spike/packs/chain-watch/oz-monitor", pullFalse: true,
    base: "openzeppelin/openzeppelin-monitor:v1.7.0@sha256:0d5ac20151328d691cfcb90eeec77d9ce4d9f2f962ddbbb90988c8e0e7c2d616",
    note: "Base pulled by digest first, then built with --pull=false." },

  // ---- web ----
  { tag: "touchstone/web-lab:dev", group: "web", kind: "build",
    context: "spike/packs/web/lab/dapp/oracle" },
  { tag: "touchstone/web-ffuf:2.3.0", group: "web", kind: "build",
    file: "spike/packs/web/Dockerfile.ffuf", context: "spike/packs/web" },
  { tag: "touchstone/web-arjun:2.2.7", group: "web", kind: "build",
    file: "spike/packs/web/Dockerfile.arjun", context: "spike/packs/web" },
  { tag: "ghcr.io/zaproxy/zaproxy:2.16.1", group: "web", kind: "pull",
    ref: "ghcr.io/zaproxy/zaproxy:2.16.1" },
  { tag: "projectdiscovery/nuclei:v3.4.2", group: "web", kind: "pull",
    ref: "projectdiscovery/nuclei:v3.4.2@sha256:d0e34e04a7180c6b944550b81fe50719f57383affcb18ae7a42c0045643d54af" },
  { tag: "projectdiscovery/nuclei:v3.4.10", group: "web", kind: "pull",
    ref: "projectdiscovery/nuclei:v3.4.10" },
  { tag: "hahwul/dalfox:v2.12.0", group: "web", kind: "pull",
    ref: "hahwul/dalfox:v2.12.0" },

  // ---- ai-mcp ----
  { tag: "touchstone/ai-mcp-lab:dev", group: "ai-mcp", kind: "build",
    context: "spike/packs/ai-mcp/lab/mcp/oracle" },
  { tag: "touchstone/mcp-inspector:0.17.2", group: "ai-mcp", kind: "build",
    file: "spike/packs/ai-mcp/Dockerfile.inspector", context: "spike/packs/ai-mcp" },
  { tag: "touchstone/mcp-shield:1.0.4", group: "ai-mcp", kind: "build",
    file: "spike/packs/ai-mcp/Dockerfile.shield", context: "spike/packs/ai-mcp" },
  { tag: "touchstone/garak:0.17.1", group: "ai-mcp", kind: "build", optional: true,
    file: "spike/packs/ai-mcp/Dockerfile.garak", context: "spike/packs/ai-mcp",
    note: "~3 GB, CPU torch. Only for live AI/MCP runs with an assistant budget." },

  // ---- surface ----
  { tag: "touchstone-jsluice:0ddfab1", group: "surface", kind: "build",
    context: "spike/packs/surface/jsluice" },

  // ---- domains + phishing ----
  { tag: "touchstone-domains-tools:wave2", group: "domains", kind: "build",
    context: "spike/packs/domains" },
  { tag: "projectdiscovery/dnsx:v1.2.2", group: "domains", kind: "pull",
    ref: "projectdiscovery/dnsx:v1.2.2@sha256:8fced0bedf3655e06c9f1805f6277d60d4988a4b13209e24b3d7cde7baa656ec" },
  { tag: "projectdiscovery/httpx:v1.7.1", group: "domains", kind: "pull",
    ref: "projectdiscovery/httpx:v1.7.1@sha256:4458ef60897c6abd1d93f7efa82c10c23b783d8ec974e2abd17e4711ff52cb41" },
  { tag: "projectdiscovery/katana:v1.2.2", group: "domains", kind: "pull",
    ref: "projectdiscovery/katana:v1.2.2@sha256:5dc4db5bea876732f2e393a460c2145de1e7385c1884b5d9129beb34acd4e45b" },
  { tag: "projectdiscovery/subfinder:v2.6.8", group: "domains", kind: "pull",
    ref: "projectdiscovery/subfinder:v2.6.8@sha256:bf8f25e6dfb8806afa917ff1d4741fabe9296152ef150a4a539115bb6a77e682" },
  { tag: "punksecurity/dnsreaper", group: "domains", kind: "pull",
    ref: "punksecurity/dnsreaper@sha256:6bd99203cf59f7137418f676d1dbf69cdc3193a808b2d91b420f5f9f33255649" },
  { tag: "touchstone-observatory:1.7.2", group: "domains", kind: "build", optional: true,
    file: "spike/packs/domains/Dockerfile.observatory", context: "spike/packs/domains",
    note: "Used by the domains smoke test only." },
  { tag: "touchstone-phishing-dnstwist:20250130", group: "phishing", kind: "build",
    context: "spike/packs/phishing" },

  // ---- supply-chain scanners (offline at run time) ----
  { tag: "ghcr.io/zizmorcore/zizmor:1.32.0", group: "supply-chain", kind: "pull",
    ref: "ghcr.io/zizmorcore/zizmor:1.32.0@sha256:3014cc8f68f663935f69b3c3e0e41f5ce102b268d97db13db0f62208747f860d" },
  { tag: "ghcr.io/boostsecurityio/poutine:1.1.6", group: "supply-chain", kind: "pull",
    ref: "ghcr.io/boostsecurityio/poutine:1.1.6@sha256:722a8e0999b583c1540fe2974e691032b2d9d21b9256a17965132b6bfd0081b0" },
  { tag: "ghcr.io/gitleaks/gitleaks:v8.30.1", group: "supply-chain", kind: "pull",
    ref: "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f" },
  { tag: "ghcr.io/google/osv-scanner:v2.7.1", group: "supply-chain", kind: "pull",
    ref: "ghcr.io/google/osv-scanner:v2.7.1@sha256:a70ffffc2bfd33482953e5d6b64c6fcdb30239717a07b0f0d3ab2859ce3e4cde" },
  { tag: "trufflesecurity/trufflehog:3.99.8", group: "supply-chain", kind: "pull",
    ref: "trufflesecurity/trufflehog:3.99.8@sha256:674b2f187620a19df77f44cf9a7d77efcc581a5662accef2f2739cbb46ba4a3a" },
  { tag: "ghcr.io/mongodb/kingfisher:2.18.1", group: "supply-chain", kind: "pull",
    ref: "ghcr.io/mongodb/kingfisher:2.18.1" },
  { tag: "touchstone-cosign:v3.1.4", group: "supply-chain", kind: "build",
    context: "spike/packs/supply-chain/cosign" },

  // ---- infra-cloud ----
  { tag: "touchstone/checkov-cli:3.4.3", group: "infra-cloud", kind: "build",
    file: "spike/packs/infra-cloud/Dockerfile.checkov", context: "spike/packs/infra-cloud" },
  { tag: "touchstone/kubescape-cli:4.0.20", group: "infra-cloud", kind: "build",
    file: "spike/packs/infra-cloud/Dockerfile.kubescape", context: "spike/packs/infra-cloud" },
  { tag: "touchstone/prowler-python:5.48.0", group: "infra-cloud", kind: "build",
    file: "spike/packs/infra-cloud/Dockerfile.prowler-python", context: "spike/packs/infra-cloud" },
  { tag: "touchstone/infra-cloud-cloud-lab:wave2", group: "infra-cloud", kind: "build",
    context: "spike/packs/infra-cloud/lab/cloud",
    note: "Live-cloud lab: private moto with IAM + node runtime for the http proof." },
  { tag: "motoserver/moto:5.2.5", group: "infra-cloud", kind: "pull",
    ref: "motoserver/moto:5.2.5@sha256:59a1965d845249b04def37a0e2565f9cc6c44543cb89b68e90f28f344b3b0d1a" },
  { tag: "aquasec/trivy:0.76.2", group: "infra-cloud", kind: "pull",
    ref: "aquasec/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb" },
  { tag: "checkmarx/kics:v2.2.1", group: "infra-cloud", kind: "pull",
    ref: "checkmarx/kics:v2.2.1@sha256:49ccc54b6ae7f5d5fc95e96f8f95c18c57f3bba047ab611a03d80792bdff6757" },
  { tag: "anchore/grype", group: "infra-cloud", kind: "pull",
    ref: "anchore/grype@sha256:13113eeceab017260370cf540e1d25442c59665fd07d1b09b66d63bb0c282887" },
  { tag: "anchore/syft", group: "infra-cloud", kind: "pull",
    ref: "anchore/syft@sha256:03215d0e98b661d0ecbc8575dbc14d65be1743b5de5df6410aecb7e80f95b060" },
  { tag: "semgrep/semgrep", group: "infra-cloud", kind: "pull",
    ref: "semgrep/semgrep@sha256:cc1b68266f267878b39739373ea9985b9a78e5d64497dd875c8de100b22695ed" },

  // ---- strix (its own sandbox; carries a docker client) ----
  { tag: "touchstone/strix:1.7.0", group: "strix", kind: "build",
    file: "tools/strix/Dockerfile", context: ".", optional: true,
    note: "Carries the Strix CLI + a docker client + the loopback model shim." },
];

// ---------------------------------------------------------------- arg parsing

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const a = argv.find((x) => x.startsWith(f + "=")); return a ? a.slice(f.length + 1) : null; };

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
  --include-optional  Include optional images (garak, observatory, strix)
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
