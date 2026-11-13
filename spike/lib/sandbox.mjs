// Per-run Foundry sandbox. Each run gets its own copy of the target repo, so the
// agent's writes never touch the real lab and runs are isolated (decision 2:
// one Docker sandbox per run). Runs are offline: --network none plus a warmed
// solc cache volume. See lab/vault-reentrancy; warm the cache once with:
//   docker volume create foundry-svm
//   docker run --rm -u 0 --entrypoint sh -v foundry-svm:/svm IMG -c 'chown 1000:1000 /svm'
//   (cd lab/vault-reentrancy && docker run --rm -v foundry-svm:/home/foundry/.svm -v "$PWD":/work -w /work IMG 'forge build')
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { SOLC_VERSION, closeRun, daytonaOn, remoteDocker } from "./daytona.mjs";

const IMG = "ghcr.io/foundry-rs/foundry:latest@sha256:3a392c18f9b16e665e932de159fb6fa9ed972c4b4352f2f76a1a8c7ca9b57d39";
const SOLC = "0.8.38";
const SVM_VOLUME = "foundry-svm";

const HERE = dirname(fileURLToPath(import.meta.url));
// A vendored forge-std to seed brief workspaces with, taken from a lab that
// already ships one. A brief has no lib/ of its own, so its PoC needs forge-std
// copied in just like a lab's does.
const FORGE_STD_SRC = join(HERE, "..", "..", "lab", "vault-reentrancy", "lib", "forge-std");

// The per-workspace config the engine writes once and every later step reads, so
// behaviour is consistent across the separate run and decide processes without
// threading it through env each time. `kind` is lab | brief; `solc` is a pinned
// version or "auto" (let forge pick per pragma); `modules` is the on/off plan.
export function writeTouchstone(ws, cfg) {
  writeFileSync(join(ws, ".touchstone.json"), JSON.stringify(cfg, null, 2));
}

export function readTouchstone(ws) {
  try {
    return JSON.parse(readFileSync(join(ws, ".touchstone.json"), "utf8"));
  } catch {
    return {};
  }
}

// The solc a workspace pins: an x.y.z version, or "auto". No `solc` field
// means the default. The value comes from .touchstone.json, which a target
// ships and a container may rewrite. It goes into shell commands. So anything
// but a plain x.y.z (an "=" prefix is allowed) counts as "auto": forge then
// picks per pragma, and nothing unchecked reaches a shell.
export function pinnedSolc(ws) {
  const raw = readTouchstone(ws).solc;
  if (raw === undefined || raw === null || raw === "") return SOLC;
  const v = String(raw).trim().replace(/^=/, "");
  return SOLC_VERSION.test(v) ? v : "auto";
}

// The `--use <solc>` fragment for a forge command, from the workspace config. A
// lab (or any config with a pinned version) compiles with that exact solc, so
// the suspect lines the static pass reported line up with the proof. "auto" (a
// brief with fetched code of unknown pragma) returns "" so forge selects the
// solc each file's pragma asks for from the warmed cache.
function solcUse(ws) {
  const v = pinnedSolc(ws);
  return v === "auto" ? "" : `--use ${v}`;
}

// Build an isolated workspace from a target repo. The oracle/ directory is never
// copied, so the agent cannot read the reference exploit.
//
// A Contracts target gets only what the agent may see: contract source, the
// vendored libs, the build config, and the target's own test/ if it has one. A target whose .touchstone.json names
// another pack gets a copy of the whole directory, with .git, because those packs
// need no Foundry files and their proofs cite commits. Nothing is added to it.
// In both cases the target's .touchstone.json, with its `pack`, goes into the
// workspace, so the engine routes the run to the right pack.
const SKIP_DIRS = new Set(["node_modules", "out", "cache", "oracle"]);

export function makeWorkspace(targetDir) {
  const ws = mkdtempSync(join(tmpdir(), "redteam-run-"));
  const cfgFile = join(targetDir, ".touchstone.json");
  const cfg = existsSync(cfgFile) ? readTouchstone(targetDir) : {};
  if (cfg.pack && cfg.pack !== "contracts") {
    // Skip by top-level name only: a nested `out` or `cache` may be real source.
    // Compare resolved paths, so "lab/x/" or a relative path still skips oracle/.
    const root = resolve(targetDir);
    cpSync(root, ws, {
      recursive: true,
      filter: (src) => !(resolve(dirname(src)) === root && SKIP_DIRS.has(basename(src))),
    });
    return ws;
  }
  cpSync(join(targetDir, "src"), join(ws, "src"), { recursive: true });
  cpSync(join(targetDir, "lib"), join(ws, "lib"), { recursive: true });
  cpSync(join(targetDir, "foundry.toml"), join(ws, "foundry.toml"));
  if (existsSync(cfgFile)) cpSync(cfgFile, join(ws, ".touchstone.json"));
  // A target's own test/ holds its property suites (Halmos check_ functions).
  if (existsSync(join(targetDir, "test"))) cpSync(join(targetDir, "test"), join(ws, "test"), { recursive: true });
  mkdirSync(join(ws, "test"), { recursive: true });
  return ws;
}

// Build an EMPTY workspace for a brief scope. There is no repo to copy: the
// code arrives at run time, when the agent's fetch_source tool clones the brief's
// linked sources into vendor/. We seed only what a Foundry proof needs regardless
// of the target — a vendored forge-std and a foundry.toml whose libs include
// vendor/, so a PoC can import both forge-std and the fetched code. src/ is left
// empty; a brief's "source" is whatever gets fetched under vendor/. The caller
// writes the .touchstone.json config. The scope text reaches the agent in its
// instructions (targets.mjs scopeEnv), not as a file here.
export function makeBriefWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "redteam-run-"));
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(join(ws, "test"), { recursive: true });
  mkdirSync(join(ws, "vendor"), { recursive: true });
  cpSync(FORGE_STD_SRC, join(ws, "lib", "forge-std"), { recursive: true });
  writeFileSync(
    join(ws, "foundry.toml"),
    `[profile.default]\nsrc = "src"\ntest = "test"\nout = "out"\nlibs = ["lib", "vendor"]\n`,
  );
  return ws;
}

export async function cleanupWorkspace(ws) {
  rmSync(ws, { recursive: true, force: true });
  // A Daytona run leaves `<ws>.daytona.json` with its machine ids. Delete those
  // machines, and wait for it: a process that exits now would lose the ids.
  // An id Daytona will not delete yet goes to the pending file.
  if (existsSync(`${ws}.daytona.json`)) await closeRun(ws).catch(() => {});
}

// Resolve a pragma expression to one concrete solc version we can pre-install.
// Exact pins ("0.8.19", "=0.8.19") map to themselves; a caret/tilde/>= range maps
// to its floor ("^0.8.19" -> "0.8.19"), which satisfies the pragma. Returns null
// when no x.y.z number is present (e.g. ">=0.8" with no patch), so the caller
// skips warming it and lets forge resolve it live if it ever can.
export function concreteSolc(pragma) {
  const m = String(pragma).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

// Pre-install a solc version into the shared svm cache volume, WITH network, so
// the later offline proof can compile fetched code that pins it. We build a
// throwaway one-line contract with `--use <version>`, which makes forge download
// that solc into the volume. Idempotent and cheap once cached. Best-effort: a
// failure (no network, bad version) is returned, not thrown, so a run continues
// and the proof simply fails to compile with a clear forge error instead.
export async function warmSolc(version) {
  const v = concreteSolc(version);
  if (!v) return { version, ok: false, skipped: true };
  // On Daytona each machine has its own cache. Note the version; every
  // machine installs it before its next forge run (see warmFor). Warm the
  // local cache too: a call that falls back to local Docker needs solc there.
  if (daytonaOn()) remoteWarm.add(v);
  const dir = mkdtempSync(join(tmpdir(), "solc-warm-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "foundry.toml"), `[profile.default]\nsrc = "src"\nout = "out"\n`);
    writeFileSync(join(dir, "src", "W.sol"), `// SPDX-License-Identifier: MIT\npragma solidity ${v};\ncontract W {}\n`);
    const args = [
      "run", "--rm", "--pull=never", // the solc download needs the network; the image is never fetched
      "-v", `${SVM_VOLUME}:/home/foundry/.svm`,
      "-v", `${dir}:/work`, "-w", "/work",
      IMG, `forge build --use ${v}`,
    ];
    const r = await run(args, 120_000);
    // "ok" just means the warm step finished and solc is now in the cache. We do
    // not fail the run on a build warning; the real test is whether the later
    // offline proof compiles, which forge reports to the agent directly.
    return { version: v, ok: !r.timedOut };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Write the agent's PoC into the workspace test dir. One fixed filename so a
// second run_poc call overwrites the first rather than piling up test files.
export function writePoc(ws, source) {
  writeFileSync(join(ws, "test", "AgentPoc.t.sol"), source);
}

// Forge prints hundreds of forge-std deprecation warnings before the real
// compile error or test result. Drop the warning blocks so the agent sees the
// signal (errors, reverts, PASS/FAIL, logs) instead of noise.
export function distill(output) {
  const lines = output.split("\n");
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    if (/There are more than \d+ warnings/.test(line)) continue; // standalone, not a block
    if (/^Warning \(\d+\):/.test(line)) { skipping = true; continue; }
    if (skipping) {
      if (line.trim() === "") { skipping = false; } // blank line ends a warning block
      continue;
    }
    kept.push(line);
  }
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const arr = text.split("\n");
  return arr.length > 80 ? arr.slice(-80).join("\n") : text; // errors/results live at the end
}

// Solc versions warmSolc was asked for while on Daytona.
const remoteWarm = new Set();

// The solc versions a Daytona machine needs before forge runs on ws: the pinned
// one, or for "auto" every concrete pragma in src/, test/ and vendor/, plus
// what warmSolc was asked for. Every value is a checked x.y.z (pinnedSolc,
// concreteSolc), so it is safe to pass to the warm script.
export function warmFor(ws) {
  const pin = pinnedSolc(ws);
  if (pin !== "auto") return [pin];
  const out = new Set(remoteWarm);
  const walk = (d) => {
    let names = [];
    try { names = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".sol")) {
        for (const m of readFileSync(p, "utf8").matchAll(/pragma\s+solidity\s+([^;]+);/g)) {
          const v = concreteSolc(m[1]);
          if (v) out.add(v);
        }
      }
    }
  };
  for (const d of ["src", "test", "vendor"]) walk(join(ws, d));
  return [...out];
}

// The most forge output we read, on both paths. A replay JSON above it is cut,
// and a cut trace is never judged: the call reports `overflow` and the proof
// says why (see proofDelta). Measured on the pinned image (H1c): a replay of a
// small token drain is about 0.4 MiB; the same drain with one forge-std
// deal(token, …) in the test BODY is about 10 MiB, with two deals or
// deal(…, true) about 20 MiB. The same deal in setUp() stays at 0.4 MiB. So the
// cap stays, and the refusal tells the agent to move deal into setUp().
export const FORGE_OUTPUT_CAP = 8 * 1024 * 1024;

// Run forge on Daytona when it is on, else in local Docker. The files forge
// writes come back, as they would locally. The proof gate needs them: it reads
// the build artifacts in out/ (see scopeCode in proof.mjs).
async function forgeRun(ws, args, timeoutMs) {
  if (daytonaOn()) {
    const r = await remoteDocker(args, { ws, timeoutMs, maxBuffer: FORGE_OUTPUT_CAP, owner: "1000:1000", warm: warmFor(ws) });
    if (r) return r;
  }
  return run(args, timeoutMs);
}

const run = (args, timeoutMs) =>
  new Promise((resolve) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: FORGE_OUTPUT_CAP }, (err, stdout, stderr) => {
      // Above maxBuffer, node kills the child and keeps only the first bytes.
      const overflow = err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      resolve({ stdout: String(stdout), stderr: String(stderr), timedOut: err?.killed === true, code: err?.code ?? 0, overflow });
    });
  });

// The pinned Foundry image and solc cache volume, so a bundle README can print
// the exact offline command and the replay verifier can run it.
export const FOUNDRY_IMAGE = IMG;
export const FOUNDRY_SVM_VOLUME = SVM_VOLUME;

// The forge invocation forgeTest runs, as one string. matchContract limits to
// one test contract; solc is a pinned version or "auto" (let forge pick).
export function forgeTestCmd({ matchContract, solc } = {}) {
  const use = solc && solc !== "auto" ? `--use ${solc} ` : "";
  const mc = matchContract ? ` --match-contract ${matchContract}` : "";
  return `forge test --offline ${use}-vv${mc}`;
}

// The standalone offline command a human runs from a bundle folder: the same
// forge invocation inside the pinned image, with $PWD mounted. It is the exact
// command the replay verifier runs, so the README never claims a different one.
export function forgeReplayCommand({ matchContract, solc } = {}) {
  return `docker run --rm --pull never --network none -v ${SVM_VOLUME}:/home/foundry/.svm -v "$PWD":/work -w /work ${IMG} '${forgeTestCmd({ matchContract, solc })}'`;
}

// Run once, online, before a replay on a fresh machine: pull nothing (the image
// is pinned by digest), create the solc cache volume and warm the pinned solc.
export function forgePrepareCommand({ solc } = {}) {
  const v = solc && solc !== "auto" ? solc : null;
  if (!v) return null;
  return [
    `docker volume create ${SVM_VOLUME}`,
    `docker run --rm -u 0 --entrypoint sh -v ${SVM_VOLUME}:/svm ${IMG} -c 'chown 1000:1000 /svm'`,
    `printf 'pragma solidity ${v}; contract W {}' > W.sol && docker run --rm -v ${SVM_VOLUME}:/home/foundry/.svm -v "$PWD":/work -w /work ${IMG} 'forge build --use ${v} W.sol' && rm -f W.sol`,
  ].join(" && \\\n  ");
}

// Run `forge test` on the workspace inside the offline container. matchContract,
// if given, limits to one test contract. Returns combined output and a pass flag.
export async function forgeTest(ws, { matchContract, timeoutMs = 180_000 } = {}) {
  const cmd = forgeTestCmd({ matchContract, solc: pinnedSolc(ws) });
  const args = [
    "run", "--rm", "--pull=never", "--network", "none",
    "-v", `${SVM_VOLUME}:/home/foundry/.svm`,
    "-v", `${ws}:/work`, "-w", "/work",
    IMG, cmd,
  ];
  const r = await forgeRun(ws, args, timeoutMs);
  const raw = (r.stdout + r.stderr).trim();
  const passed = /\b([1-9]\d*) passed; 0 failed/.test(raw);
  const failed = /[1-9]\d* failed/.test(raw) || /compilation failed|Compilation failed|Error \(\d+\)|Error:/i.test(raw);
  return { output: distill(raw), passed, failed, timedOut: r.timedOut, code: r.code };
}

// Run the SAME test again in JSON mode at full trace verbosity. This is the
// engine's structured proof pass: `--json -vvvv` makes forge emit, per test, the
// real pass/fail, gas, decoded logs, and the full call trace with every ETH
// value transfer — the machine-truth the proof-delta reader turns into a signed
// money-moved table. We never distill; the raw JSON is parsed by lib/proof.mjs.
export async function forgeTestJson(ws, { matchContract, timeoutMs = 180_000, stateTrace = false } = {}) {
  // -vvvvv adds a storage_change to every EVM step: the replay state diff. It is large, so opt in.
  // --extra-output storageLayout writes each compiled contract's storage layout into its build
  // artifact. The harm gate reads it to know which slot holds an address-typed control variable
  // (owner/admin/governor), so control-slot takeovers are judged from the real layout, not from a
  // position/value guess. It only enlarges the artifact JSON; the replay is unchanged.
  let cmd = `forge test --offline ${solcUse(ws)} --extra-output storageLayout ${stateTrace ? "-vvvvv" : "-vvvv"} --json`;
  if (matchContract) cmd += ` --match-contract ${matchContract}`;
  // --pull=never, one word: the only form planRemote (lib/daytona.mjs) accepts, as forgeTest.
  const args = [
    "run", "--rm", "--pull=never", "--network", "none",
    "-v", `${SVM_VOLUME}:/home/foundry/.svm`,
    "-v", `${ws}:/work`, "-w", "/work",
    IMG, cmd,
  ];
  const r = await forgeRun(ws, args, timeoutMs);
  // A cut output is never parsed: raw is empty and `overflow` says why.
  if (r.overflow) return { raw: "", stderr: String(r.stderr).trim(), timedOut: r.timedOut, overflow: true };
  // forge prints the JSON object on stdout; warnings/errors go to stderr.
  return { raw: String(r.stdout).trim(), stderr: String(r.stderr).trim(), timedOut: r.timedOut, overflow: false };
}
