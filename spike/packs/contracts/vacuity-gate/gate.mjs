#!/usr/bin/env node
// Vacuity gate: decide whether a Foundry invariant suite is evidence or theatre.
//
// A suite is evidence only if all three hold:
//   1. liveness  - the handler reaches the target and leaves the initial state
//   2. mutants   - at least one small defect in the target is killed
//   3. known bug - when a planted bug exists, at least one invariant fails on it
//
// The gate always works on a throwaway copy. It never edits the project.
//
// Usage:
//   node gate.mjs --project <dir> --test <test/File.t.sol> [--known-bug]
//
// stdout is one JSON verdict. Progress goes to stderr.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runDocker } from "../../../lib/wrap.mjs";

const IMAGE = "ghcr.io/foundry-rs/foundry@sha256:3a392c18f9b16e665e932de159fb6fa9ed972c4b4352f2f76a1a8c7ca9b57d39";
const REPAIR = {
  find: "    function rescue(address payable to, uint256 amount) external {",
  replace: "    function rescue(address payable to, uint256 amount) external onlyOwner {",
};
const USER = `${process.getuid()}:${process.getgid()}`;

const SKIP = new Set(["out", "cache", ".git", "broadcast", ".vacuity-gate"]);

// Fixed, deterministic mutants. Each is one literal edit of the reference
// FeeVault. A pattern must occur exactly once, else the mutant is reported as
// not applied and is excluded from the kill rate.
const MUTANTS = [
  {
    id: "remove-deposit-zero-check",
    find: '        require(msg.value > 0, "zero deposit");\n',
    replace: "",
  },
  {
    id: "remove-withdraw-amount-guard",
    find: '        require(amount > 0 && balanceOf[msg.sender] >= amount, "bad amount");\n',
    replace: "",
  },
  {
    id: "rescue-ignores-failed-transfer",
    find: '        require(ok, "transfer failed");\n    }\n\n    function totalAssets',
    replace: '        ok;\n    }\n\n    function totalAssets',
  },
  {
    id: "fee-divisor-1000",
    find: [
      '        require(amount > 0 && balanceOf[msg.sender] >= amount, "bad amount");',
      "        uint256 fee = (amount * feeBps) / 10_000;",
    ].join("\n"),
    replace: [
      '        require(amount > 0 && balanceOf[msg.sender] >= amount, "bad amount");',
      "        uint256 fee = (amount * feeBps) / 1_000;",
    ].join("\n"),
  },
  {
    id: "fee-accumulate-assign",
    find: "        balanceOf[msg.sender] -= amount;\n        feesAccrued += fee;",
    replace: "        balanceOf[msg.sender] -= amount;\n        feesAccrued = fee;",
  },
  {
    id: "withdraw-write-after-call",
    find: [
      "        balanceOf[msg.sender] -= amount;",
      "        feesAccrued += fee;",
      '        (bool ok, ) = msg.sender.call{value: amount - fee}("");',
      '        require(ok, "transfer failed");',
      "        emit Withdraw(msg.sender, amount, fee);",
    ].join("\n"),
    replace: [
      '        (bool ok, ) = msg.sender.call{value: amount - fee}("");',
      '        require(ok, "transfer failed");',
      "        balanceOf[msg.sender] -= amount;",
      "        feesAccrued += fee;",
      "        emit Withdraw(msg.sender, amount, fee);",
    ].join("\n"),
  },
];

function log(msg) {
  process.stderr.write(`[gate] ${msg}\n`);
}

function parseArgs(argv) {
  const out = { knownBug: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") out.project = argv[++i];
    else if (a === "--test") out.test = argv[++i];
    else if (a === "--known-bug") out.knownBug = true;
    else if (a === "--keep") out.keep = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.project || !out.test) throw new Error("--project and --test are required");
  out.project = path.resolve(out.project);
  if (fs.lstatSync(out.project).isSymbolicLink() || !fs.statSync(out.project).isDirectory()) throw new Error(`not a real directory: ${out.project}`);
  const relative = path.relative(out.project, path.resolve(out.project, out.test));
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`test must be inside the project: ${out.test}`);
  }
  let current = out.project;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`test symlink forbidden: ${out.test}`);
  }
  if (!fs.statSync(current).isFile()) throw new Error(`no such test file: ${out.test}`);
  out.test = relative;
  return out;
}

function copyProject(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(src, p);
      if (!rel) return true;
      if (SKIP.has(rel.split(path.sep)[0])) return false;
      if (fs.lstatSync(p).isSymbolicLink()) throw new Error(`project symlink forbidden: ${rel}`);
      return true;
    },
  });
}

// Follow both relative and Foundry remapped imports. Do not mistake an unused
// helper for evidence; only files reachable from the selected test matter.
function fingerprintReads(root, test) {
  const found = [], seen = new Set();
  const config = fs.readFileSync(path.join(root, "foundry.toml"), "utf8");
  const remaps = [...config.matchAll(/"([^"\s=]+)=([^"\s]+)"/g)].map((m) => [m[1], m[2]]);
  function walk(file) {
    if (seen.has(file) || file.startsWith(path.join(root, "lib", "forge-std") + path.sep)) return;
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) throw new Error(`unresolved project import: ${file}`);
    seen.add(file);
    const text = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    if (/\.code(?:hash|\b)|\bextcode(?:hash|size|copy)\b|\b(?:creationCode|runtimeCode)\b|\bgetCode\s*\(/i.test(text)) {
      found.push(path.relative(root, file));
    }
    for (const match of text.matchAll(/\bimport\s+(?:[^;]*?\bfrom\s*)?["']([^"']+)["']\s*;/g)) {
      const name = match[1];
      if (name.startsWith("forge-std/")) continue;
      const mapped = remaps.find(([prefix]) => name.startsWith(prefix));
      const candidates = name.startsWith(".") ? [path.resolve(path.dirname(file), name)] : [
        path.resolve(root, name),
        ...(mapped ? [path.resolve(root, mapped[1], name.slice(mapped[0].length))] : []),
        path.resolve(root, "lib", name.split("/")[0], "src", ...name.split("/").slice(1)),
      ];
      walk(candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]);
    }
  }
  walk(path.resolve(root, test));
  return found;
}

function svmVolume() {
  for (const name of ["foundry-svm", "touchstone_svm_cache"]) {
    try {
      execFileSync("docker", ["volume", "inspect", name], { stdio: "ignore" });
      return name;
    } catch {}
  }
  return null;
}

async function forge(ws, argv, timeoutMs = 300_000) {
  const volume = svmVolume();
  const args = [
    "run", "--rm", "--pull=never", "--network", "none",
    "-e", "FOUNDRY_INVARIANT_RUNS=1",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "512", "--memory", "2g", "--user", USER,
    "-v", `${ws}:/work`, "-w", "/work",
    ...(volume ? ["-v", `${volume}:/home/foundry/.svm`] : []),
    "--entrypoint", "forge", IMAGE, ...argv,
  ];
  return runDocker(args, { ws, timeoutMs });
}

function resultsFile(ws) {
  return path.join(ws, ".vacuity-gate", "results.json");
}

async function runSuite(ws, test, { debug = false, matchTest = null } = {}) {
  const dir = path.join(ws, ".vacuity-gate");
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.rmSync(resultsFile(ws));
  } catch {}
  const argv = ["test", "--match-path", test, "--match-test", matchTest ?? "^invariant_", "--json-file", ".vacuity-gate/results.json"];
  if (debug) argv.push("--debug", "--dump", ".vacuity-gate/dump");
  const run = await forge(ws, argv);
  let results = null;
  try {
    results = JSON.parse(fs.readFileSync(resultsFile(ws), "utf8"));
  } catch {}
  return { ...run, results };
}

function allTestResults(results) {
  const list = [];
  for (const [suite, data] of Object.entries(results ?? {})) {
    for (const [name, tr] of Object.entries(data.test_results ?? {})) list.push({ suite, name, tr });
  }
  return list;
}

function invariantStatuses(run) {
  const tests = allTestResults(run.results);
  if (run.timedOut || !tests.length || tests.some(({ name, tr }) =>
    !name.startsWith("invariant_") || !tr.kind?.Invariant || !["Success", "Failure"].includes(tr.status))) return null;
  const statuses = new Map();
  for (const { name, tr } of tests) {
    statuses.set(name, tr.status);
    for (const p of tr.invariant_predicate_results ?? []) {
      if (!["Success", "Failure"].includes(p.status)) return null;
      statuses.set(p.name, p.status);
    }
  }
  return statuses;
}

function failures(statuses) {
  return [...(statuses ?? [])].filter(([, status]) => status === "Failure").map(([name]) => name).sort();
}

function metricsOf(results) {
  for (const { tr } of allTestResults(results)) {
    const m = tr.kind?.Invariant?.metrics;
    if (m) return m;
  }
  return null;
}

function tracedTargetCalls(results, target) {
  const calls = [];
  for (const { tr } of allTestResults(results)) {
    for (const [label, trace] of tr.traces ?? []) {
      if (label !== "Execution") continue;
      for (const node of trace.arena ?? []) {
        const t = node.trace;
        if (t.address?.toLowerCase() !== target.toLowerCase() || t.kind === "CREATE") continue;
        calls.push(t);
      }
    }
  }
  return calls;
}

// The debugger dump contains the replayed campaign's storage deltas. A write
// counts only when its handler action commits and its final value differs.
function committedStorageChanges(dumpDir, target, handlers, handlerMethods, metrics) {
  let trace;
  try {
    trace = JSON.parse(fs.readFileSync(path.join(dumpDir, "trace.json"), "utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(trace.steps) || !Array.isArray(trace.artifacts?.calls)) return null;
  const calls = trace.artifacts.calls;
  const byId = new Map(calls.map((c) => [c.id, c]));
  const roots = calls.filter((c) => c.parent_id == null && handlers.has(c.to?.toLowerCase()) && c.success);
  const seen = new Map();
  let changes = 0;
  for (const root of roots) {
    const method = handlerMethods.get(root.to.toLowerCase())?.get(root.input?.slice(0, 10).toLowerCase());
    if (!method) continue;
    seen.set(method, (seen.get(method) ?? 0) + 1);
    if (seen.get(method) > (metrics[method]?.calls ?? 0)) continue;
    const slots = new Map();
    for (const c of calls) {
      if (c.to?.toLowerCase() !== target.toLowerCase() || !c.success || !Number.isInteger(c.entry_step)) continue;
      let parent = c;
      while (parent.parent_id != null && parent.success) parent = byId.get(parent.parent_id);
      if (parent !== root || !root.success) continue;
      for (let i = c.entry_step; i <= c.exit_step; i++) {
        const step = trace.steps[i];
        if (step?.op !== "SSTORE" || step.depth !== c.depth) continue;
        for (const [slot, delta] of Object.entries(step.snapshot?.storage_diff ?? {})) {
          const existing = slots.get(slot);
          slots.set(slot, { before: existing ? existing.before : delta.before, after: delta.after });
        }
      }
    }
    changes += [...slots.values()].filter((v) => v.before != null && v.after != null && BigInt(v.before) !== BigInt(v.after)).length;
  }
  return changes;
}

function contracts(dumpDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dumpDir, "contracts.json"), "utf8")).contracts ?? [];
  } catch {
    return [];
  }
}

// The deployed contract's source path is the key of its `contracts` entry.
function declaredSources(dumpDir, contract) {
  try {
    const combined = JSON.parse(fs.readFileSync(path.join(dumpDir, contract.debug_dir, "combined.json"), "utf8"));
    return Object.keys(combined.contracts ?? {}).map((k) => k.split(":")[0]);
  } catch {
    return [];
  }
}

function resolveTarget(dumpDir, testPath, results) {
  const list = contracts(dumpDir);
  const testDir = path.dirname(testPath);
  const inTestDir = (c) => declaredSources(dumpDir, c).some((f) => f === testDir || f.startsWith(`${testDir}/`));
  const sourceOf = (c) => declaredSources(dumpDir, c).find((f) => f.startsWith("src/") || f.startsWith("./src/")) ?? null;
  const testContract = list.find((c) => c.name === path.basename(testPath, ".t.sol"));
  const handlers = new Set(list.filter((c) => c !== testContract && inTestDir(c)).map((c) => c.address));
  const candidates = list.filter((c) => c !== testContract && !handlers.has(c.address) && sourceOf(c));
  if (candidates.length === 1) return { target: candidates[0].address, name: candidates[0].name, handlers };
  // Fallback: pick the candidate with the most execution calls.
  let best = null;
  for (const c of candidates) {
    const n = tracedTargetCalls(results, c.address).length;
    if (!best || n > best.n) best = { n, c };
  }
  if (best && best.n > 0) return { target: best.c.address, name: best.c.name, handlers };
  return { target: null, name: null, handlers };
}

async function inspectSelectors(ws, name) {
  const r = await forge(ws, ["inspect", name, "methods"]);
  if (r.code !== 0 || r.timedOut) throw new Error(`forge inspect failed: ${(r.stderr || r.stdout).trim().slice(-300)}`);
  const map = new Map();
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^\|\s*(\S+\([^)]*\))\s*\|\s*([0-9a-fA-F]{8})\s*\|/);
    if (m) map.set(`0x${m[2].toLowerCase()}`, m[1]);
  }
  return map;
}

function livenessCheck({ dumpDir, results, target, handlers, handlerMethods }) {
  const metrics = metricsOf(results) ?? {};
  const handlerCalls = Object.values(metrics).reduce((n, m) => n + (m.calls ?? 0), 0);
  const handlerReverts = Object.values(metrics).reduce((n, m) => n + (m.reverts ?? 0), 0);
  const bySelector = new Map();
  let tracedActions = 0, successfulTargetCalls = 0, successfulValueCalls = 0, targetCalls = 0, balanceChanges = 0;
  const tracedMethods = new Map();
  for (const { tr } of allTestResults(results)) {
    for (const [label, trace] of tr.traces ?? []) {
      if (label !== "Execution") continue;
      const arena = trace.arena ?? [];
      const root = arena.find((n) => n.parent == null);
      if (!root || !handlers.has(root.trace?.address?.toLowerCase()) || root.trace.kind === "STATICCALL") continue;
      tracedActions++;
      const method = handlerMethods.get(root.trace.address.toLowerCase())?.get(root.trace.data?.slice(0, 10).toLowerCase());
      if (method) tracedMethods.set(method, (tracedMethods.get(method) ?? 0) + 1);
      if (!method || tracedMethods.get(method) > (metrics[method]?.calls ?? 0)) continue;
      let balanceDelta = 0n;
      for (const node of arena) {
        const c = node.trace;
        if (c.address?.toLowerCase() !== target.toLowerCase() || c.kind === "CREATE") continue;
        targetCalls++;
        let parent = node;
        let committed = true;
        while (parent) {
          if (!parent.trace.success) committed = false;
          parent = parent.parent == null ? null : arena[parent.parent];
        }
        const sel = (c.data ?? "0x").slice(0, 10).toLowerCase();
        const row = bySelector.get(sel) ?? { selector: sel, calls: 0, successes: 0 };
        row.calls++;
        if (committed) {
          row.successes++;
          successfulTargetCalls++;
          const value = BigInt(c.value ?? "0x0");
          if (value > 0n) successfulValueCalls++;
          balanceDelta += value;
        }
        bySelector.set(sel, row);
      }
      // Include ETH paid out by the target, not only ETH received by it.
      if (root.trace.success) for (const node of arena) {
        const c = node.trace;
        if (c.caller?.toLowerCase() !== target.toLowerCase() || !c.success) continue;
        let parent = node;
        let committed = true;
        while (parent) {
          if (!parent.trace.success) committed = false;
          parent = parent.parent == null ? null : arena[parent.parent];
        }
        if (committed) balanceDelta -= BigInt(c.value ?? "0x0");
      }
      if (root.trace.success && balanceDelta !== 0n) balanceChanges++;
    }
  }
  const storageChanges = committedStorageChanges(dumpDir, target, handlers, handlerMethods, metrics);
  const dead = [...bySelector.values()].filter((r) => r.successes === 0);
  const reasons = [];
  // Forge may append one debugger replay action beyond the recorded metrics.
  if (!handlerCalls || tracedActions < handlerCalls || tracedActions > handlerCalls + 1 ||
      Object.entries(metrics).some(([method, m]) => (tracedMethods.get(method) ?? 0) < m.calls)) {
    reasons.push(`liveness: incomplete campaign trace (${tracedActions}/${handlerCalls} actions)`);
  }
  if (targetCalls === 0) reasons.push("liveness: handler never reached the target");
  if (targetCalls && !successfulTargetCalls) reasons.push("liveness: every target call failed or was rolled back");
  if (dead.length) reasons.push(`liveness: ${dead.length} selector(s) never succeeded`);
  if (storageChanges == null) reasons.push("liveness: debugger storage evidence unavailable");
  if (!balanceChanges && !storageChanges) reasons.push("liveness: no committed target balance or storage-value change");
  return {
    pass: reasons.length === 0, targetCalls, successfulTargetCalls,
    failedTargetCalls: targetCalls - successfulTargetCalls, successfulValueCalls,
    storageChanges, balanceChanges, handlerCalls, handlerReverts, tracedActions,
    targetCallSuccessRate: targetCalls ? Number((successfulTargetCalls / targetCalls).toFixed(4)) : 0,
    selectors: [...bySelector.values()], deadSelectors: dead.map((r) => r.selector), reasons,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const volume = svmVolume();
  if (!volume) throw new Error("no solc cache volume (foundry-svm or touchstone_svm_cache); refusing to use the network");
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
  } catch {
    throw new Error(`preinstalled pinned Forge image missing: ${IMAGE}; refusing to pull`);
  }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vacuity-gate-"));
  const ws = path.join(base, "project");
  const verdict = {
    pass: false,
    liveness: { pass: false, reasons: [] },
    mutants: [],
    killRate: 0,
    knownBug: { planted: opts.knownBug, detected: false, failingInvariants: [] },
    reasons: [],
  };

  try {
    log(`copying ${opts.project}`);
    copyProject(opts.project, ws);
    const fingerprints = fingerprintReads(ws, opts.test);
    if (fingerprints.length) {
      verdict.reasons.push(`control: code fingerprint reads are not behavioral evidence (${fingerprints.join(", ")})`);
      return verdict;
    }
    const invariant = fs.readFileSync(path.join(ws, opts.test), "utf8").match(/\bfunction\s+(invariant_\w+)/)?.[1];
    if (!invariant) {
      verdict.reasons.push("control: no invariant function found");
      return verdict;
    }
    const matchTest = `^${invariant}\\(`;
    const targetSourcePath = path.join(ws, "src", "FeeVault.sol");
    if (opts.knownBug) {
      const text = fs.readFileSync(targetSourcePath, "utf8");
      if (text.split(REPAIR.find).length !== 2) {
        verdict.reasons.push("known-bug: reference repair pattern must occur exactly once");
        return verdict;
      }
      const buggy = path.join(base, "buggy");
      copyProject(ws, buggy);
      fs.writeFileSync(targetSourcePath, text.replace(REPAIR.find, REPAIR.replace));
    }

    log("healthy control: compiling and running the same invariant selection");
    const build = await forge(ws, ["build", "--quiet"]);
    if (build.code !== 0) {
      verdict.reasons.push(`compile: ${(build.stderr || build.stdout).trim().split("\n").slice(-3).join(" ")}`);
      return verdict;
    }


    // One configured invariant run makes the debugger replay the entire
    // scored campaign. The other predicates still appear in its result.
    const baseRun = await runSuite(ws, opts.test, { debug: true, matchTest });
    const healthy = invariantStatuses(baseRun);
    if (!healthy || baseRun.code !== 0 || failures(healthy).length) {
      verdict.reasons.push("control: healthy reference must pass every selected invariant (no skips or execution errors)");
      return verdict;
    }
    const dumpDir = path.join(ws, ".vacuity-gate", "dump");
    const { target, name, handlers } = resolveTarget(dumpDir, opts.test, baseRun.results);
    if (opts.knownBug) {
      const buggyRun = await runSuite(path.join(base, "buggy"), opts.test, { matchTest });
      const buggy = invariantStatuses(buggyRun);
      verdict.knownBug.failingInvariants = failures(buggy).filter((name) => healthy.get(name) === "Success");
      verdict.knownBug.detected = Boolean(buggy && buggyRun.code === 1 && !buggyRun.timedOut && verdict.knownBug.failingInvariants.length);
      if (!verdict.knownBug.detected) verdict.reasons.push("known-bug: no new invariant Failure against the repaired reference");
    }

    if (!target) {
      verdict.liveness = { pass: false, reasons: ["liveness: could not identify a target contract outside the test directory"] };
      verdict.reasons.push(...verdict.liveness.reasons);
      return verdict;
    }
    log(`target: ${name} (${target})`);

    const handlerMethods = new Map();
    for (const c of contracts(dumpDir).filter((c) => handlers.has(c.address))) {
      const methods = await inspectSelectors(ws, `${opts.test}:${c.name}`);
      handlerMethods.set(c.address.toLowerCase(), new Map([...methods].map(([selector, signature]) =>
        [selector, `${opts.test}:${c.name}.${signature.split("(")[0]}`])));
    }
    verdict.liveness = livenessCheck({ dumpDir, results: baseRun.results, target,
      handlers: new Set([...handlers].map((h) => h.toLowerCase())), handlerMethods });
    const names = await inspectSelectors(ws, name);
    for (const row of verdict.liveness.selectors) row.name = names.get(row.selector) ?? null;
    verdict.liveness.deadSelectors = verdict.liveness.deadSelectors.map((s) => names.get(s) ?? s);
    if (!verdict.liveness.pass) {
      verdict.reasons.push(...verdict.liveness.reasons);
      return verdict;
    }

    const src = contracts(dumpDir)
      .find((c) => c.address === target);
    const targetSource = src ? declaredSources(dumpDir, src).find((f) => f.startsWith("src/") || f.startsWith("./src/")) : null;
    if (!targetSource) {
      verdict.reasons.push("mutants: could not locate the target source file");
    } else {
      log(`mutants: ${MUTANTS.length} against ${targetSource}`);
      for (const [i, mutant] of MUTANTS.entries()) {
        const mws = path.join(base, `mutant-${i}`);
        copyProject(ws, mws);
        const file = path.join(mws, targetSource);
        const text = fs.readFileSync(file, "utf8");
        const hits = text.split(mutant.find).length - 1;
        const entry = { id: mutant.id, applied: hits === 1, compiled: false, killed: false };
        verdict.mutants.push(entry);
        if (hits !== 1) {
          log(`${mutant.id}: pattern hits ${hits}, skipped`);
          continue;
        }
        fs.writeFileSync(file, text.replace(mutant.find, mutant.replace));
        const mb = await forge(mws, ["build", "--quiet"]);
        if (mb.code !== 0) {
          entry.error = "compile failed";
          continue;
        }
        entry.compiled = true;
        const mr = await runSuite(mws, opts.test, { matchTest });
        const mutantStatuses = invariantStatuses(mr);
        entry.failingInvariants = failures(mutantStatuses).filter((name) => healthy.get(name) === "Success");
        entry.killed = Boolean(mutantStatuses && mr.code === 1 && !mr.timedOut && entry.failingInvariants.length);
        log(`${mutant.id}: ${entry.killed ? "killed" : "survived"}`);
      }
      const applied = verdict.mutants.filter((m) => m.applied && m.compiled);
      const killed = applied.filter((m) => m.killed);
      verdict.killRate = applied.length ? Number((killed.length / applied.length).toFixed(4)) : 0;
      if (killed.length === 0) verdict.reasons.push(`mutants: killed 0 of ${applied.length} applied mutants`);
    }

    verdict.pass = verdict.liveness.pass && verdict.killRate > 0 && (!opts.knownBug || verdict.knownBug.detected);
    return verdict;
  } finally {
    if (opts.keep) log(`kept ${base}`);
    else fs.rmSync(base, { recursive: true, force: true });
  }
}

main()
  .then((v) => {
    process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
    process.exitCode = v.pass ? 0 : 1;
  })
  .catch((e) => {
    process.stdout.write(`${JSON.stringify({ pass: false, error: String(e), reasons: [String(e)] }, null, 2)}\n`);
    process.exitCode = 1;
  });
