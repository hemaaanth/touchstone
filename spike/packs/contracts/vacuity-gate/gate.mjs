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

const IMAGE = "ghcr.io/foundry-rs/foundry:latest";
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
  if (!fs.statSync(out.project).isDirectory()) throw new Error(`not a directory: ${out.project}`);
  if (!fs.statSync(path.join(out.project, out.test)).isFile()) throw new Error(`no such test file: ${out.test}`);
  return out;
}

function copyProject(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(src, p);
      if (!rel) return true;
      return !SKIP.has(rel.split(path.sep)[0]);
    },
  });
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
    "run", "--rm", "--network", "none",
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
  const argv = ["test", "--match-path", test, "--json-file", ".vacuity-gate/results.json"];
  if (debug) {
    if (matchTest) argv.push("--match-test", matchTest);
    argv.push("--debug", "--dump", ".vacuity-gate/dump");
  }
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

function failingNames(results) {
  const names = new Set();
  for (const { name, tr } of allTestResults(results)) {
    if (tr.status !== "Success") names.add(name);
    for (const p of tr.invariant_predicate_results ?? []) {
      if (p.status !== "Success") names.add(p.name);
    }
  }
  return [...names].sort();
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

function storageWrites(dumpDir, target) {
  let trace;
  try {
    trace = JSON.parse(fs.readFileSync(path.join(dumpDir, "trace.json"), "utf8"));
  } catch {
    return 0;
  }
  const calls = (trace.artifacts?.calls ?? []).filter(
    (c) => c.success && c.to?.toLowerCase() === target.toLowerCase(),
  );
  let writes = 0;
  for (const c of calls) {
    for (const step of trace.steps ?? []) {
      if (
        step.op === "SSTORE" &&
        step.depth === c.depth &&
        Number.isInteger(c.entry_step) && Number.isInteger(c.exit_step) &&
        step.pc >= 0 &&
        trace.steps.indexOf(step) >= c.entry_step &&
        trace.steps.indexOf(step) <= c.exit_step
      ) {
        writes++;
      }
    }
  }
  return writes;
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

function inspectSelectors(ws, name) {
  const r = execFileSync("docker", [
    "run", "--rm", "--network", "none", "--user", USER,
    "-v", `${ws}:/work`, "-w", "/work",
    ...(svmVolume() ? ["-v", `${svmVolume()}:/home/foundry/.svm`] : []),
    "--entrypoint", "forge", IMAGE, "inspect", name, "methods",
  ], { encoding: "utf8" });
  const map = new Map();
  for (const line of r.split("\n")) {
    const m = line.match(/^\|\s*(\S+\([^)]*\))\s*\|\s*([0-9a-fA-F]{8})\s*\|/);
    if (m) map.set(`0x${m[2].toLowerCase()}`, m[1]);
  }
  return map;
}

function livenessCheck({ dumpDir, test, results, target }) {
  const calls = tracedTargetCalls(results, target);
  const successful = calls.filter((c) => c.success);
  const value = successful.filter((c) => BigInt(c.value ?? "0x0") > 0n);
  const bySelector = new Map();
  for (const c of calls) {
    const sel = (c.data ?? "0x").slice(0, 10).toLowerCase();
    const row = bySelector.get(sel) ?? { selector: sel, calls: 0, successes: 0 };
    row.calls++;
    if (c.success) row.successes++;
    bySelector.set(sel, row);
  }
  const dead = [...bySelector.values()].filter((r) => r.successes === 0);
  const failed = calls.length - successful.length;
  const writes = storageWrites(dumpDir, target);
  const metrics = metricsOf(results) ?? {};
  const handlerCalls = Object.values(metrics).reduce((n, m) => n + (m.calls ?? 0), 0);
  const handlerReverts = Object.values(metrics).reduce((n, m) => n + (m.reverts ?? 0), 0);

  const reasons = [];
  if (calls.length === 0) reasons.push("liveness: handler never reached the target");
  if (calls.length > 0 && successful.length === 0) reasons.push("liveness: every target call failed");
  if (dead.length) reasons.push(`liveness: ${dead.length} selector(s) never succeeded`);
  if (value.length === 0 && writes === 0) reasons.push("liveness: target state never moved");

  return {
    pass: reasons.length === 0,
    targetCalls: calls.length,
    successfulTargetCalls: successful.length,
    failedTargetCalls: failed,
    successfulValueCalls: value.length,
    storageWrites: writes,
    targetCallSuccessRate: calls.length ? Number((successful.length / calls.length).toFixed(4)) : 0,
    handlerCalls,
    handlerReverts,
    selectors: [...bySelector.values()].map((r) => ({
      selector: r.selector,
      calls: r.calls,
      successes: r.successes,
    })),
    deadSelectors: dead.map((r) => r.selector),
    reasons,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const volume = svmVolume();
  if (!volume) throw new Error("no solc cache volume (foundry-svm or touchstone_svm_cache); refusing to use the network");

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

    log("baseline: compiling and running the suite");
    const build = await forge(ws, ["build", "--quiet"]);
    if (build.code !== 0) {
      verdict.reasons.push(`compile: ${(build.stderr || build.stdout).trim().split("\n").slice(-3).join(" ")}`);
      return verdict;
    }


    // `--debug` needs exactly one test. Any invariant runs the whole handler
    // campaign, and its result lists every predicate, so one is enough.
    const invariant = fs.readFileSync(path.join(ws, opts.test), "utf8").match(/\bfunction\s+(invariant_\w+)/)?.[1];
    const baseRun = await runSuite(ws, opts.test, { debug: true, matchTest: invariant });
    if (!baseRun.results) {
      verdict.reasons.push(`run: forge produced no results (${(baseRun.stderr || baseRun.stdout).trim().split("\n").slice(-3).join(" ")})`);
      return verdict;
    }

    const dumpDir = path.join(ws, ".vacuity-gate", "dump");
    const { target, name, handlers } = resolveTarget(dumpDir, opts.test, baseRun.results);
    const baseFails = failingNames(baseRun.results);

    if (opts.knownBug) {
      verdict.knownBug.detected = baseFails.length > 0;
      verdict.knownBug.failingInvariants = baseFails;
    }

    if (!target) {
      verdict.liveness = { pass: false, reasons: ["liveness: could not identify a target contract outside the test directory"] };
      verdict.reasons.push(...verdict.liveness.reasons);
      if (opts.knownBug && !verdict.knownBug.detected) verdict.reasons.push("known-bug: the suite passed on the original buggy source");
      return verdict;
    }
    log(`target: ${name} (${target})`);

    verdict.liveness = livenessCheck({ dumpDir, test: opts.test, results: baseRun.results, target });
    const names = inspectSelectors(ws, name);
    for (const row of verdict.liveness.selectors) row.name = names.get(row.selector) ?? null;
    verdict.liveness.deadSelectors = verdict.liveness.deadSelectors.map((s) => names.get(s) ?? s);
    if (!verdict.liveness.pass) verdict.reasons.push(...verdict.liveness.reasons);
    if (opts.knownBug && !verdict.knownBug.detected) verdict.reasons.push("known-bug: the suite passed on the original buggy source");

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
        const mr = await runSuite(mws, opts.test);
        entry.killed = Boolean(mr.results) && failingNames(mr.results).length > 0;
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
