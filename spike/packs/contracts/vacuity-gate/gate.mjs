#!/usr/bin/env node
// Vacuity gate: decide whether a Foundry invariant suite is evidence or theatre.
//
// A suite is evidence only if all of these hold:
//   1. environment  - the gate owns foundry.toml, forge-std and the fuzz seed
//   2. scan         - no compiled project source reads code, files, env or randomness
//   3. control      - the invariant passes on the healthy FeeVault, also in a strong campaign
//   4. differential - it also passes on build B: same behavior, different bytes
//   5. liveness     - the handler reaches src/FeeVault.sol and changes its state
//   6. known bug    - an invariant fails on the planted rescue() bug
//   7. mutants      - at least one small defect in src/FeeVault.sol is killed,
//                     and the kill rate is at least --min-kill-rate
//
// The healthy reference is always src/FeeVault.sol with rescue() repaired, and
// the known-bug check always runs. The target is pinned to one file whose one
// planted bug is known, so there is no run where the bug is absent.
//
// The gate always works on throwaway copies. It never edits the project.
//
// Usage:
//   node gate.mjs --project <dir> --test <test/File.t.sol> [--min-kill-rate <0..1>] [--keep]
//   --known-bug is still accepted, for old command lines. It changes nothing.
//
// stdout is one JSON verdict. Progress goes to stderr.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runTool } from "../../../lib/wrap.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = "ghcr.io/foundry-rs/foundry@sha256:3a392c18f9b16e665e932de159fb6fa9ed972c4b4352f2f76a1a8c7ca9b57d39";
const SOLC = "0.8.38";
// One fixed seed for every run: healthy A, healthy B, known bug, each mutant.
const SEED = "0x7661637569747921";
// The kill-rate bar. The gate passes only when at least one mutant is killed
// and killed / scored >= this. The owner may raise it; --min-kill-rate overrides.
const MIN_KILL_RATE = 0;
const CAMPAIGN = {
  score: { runs: 32, depth: 32 }, // A, B, known bug and mutants are compared with this
  strong: { runs: 256, depth: 32 }, // healthy A only, no --debug
  debug: { runs: 1, depth: 32 }, // one replayed campaign for the liveness trace
};
// The gate's own forge-std. The project's lib/forge-std is never copied or compiled.
const FORGE_STD = {
  version: "1.9.4",
  dir: path.join(HERE, "vendor", "forge-std", "src"),
  // sha256 over sorted lines "<relative path>\0<sha256 of file>\n" for every file in src/.
  treeSha256: "bc3cf851aeea54c57710b26436641a985a599ba4d1eaa98fba7317773c3194ca",
  mount: "/forge-std/src",
};
// The scored target is fixed. A decoy contract cannot take its place.
const TARGET = {
  path: "src/FeeVault.sol",
  contract: "FeeVault",
  sha256: "131fcfda4b5b4fe2d3e1c3653c9d034c4781447afefa31efe83f89742843d615",
};
const REPAIR = {
  find: "    function rescue(address payable to, uint256 amount) external {",
  replace: "    function rescue(address payable to, uint256 amount) external onlyOwner {",
};

const SKIP = new Set(["out", "cache", ".git", "broadcast", ".vacuity-gate", "node_modules"]);

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

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

function parseArgs(argv) {
  const out = { keep: false, minKillRate: MIN_KILL_RATE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") out.project = argv[++i];
    else if (a === "--test") out.test = argv[++i];
    else if (a === "--known-bug") continue; // always on; kept for old command lines
    else if (a === "--min-kill-rate") {
      const v = argv[++i];
      out.minKillRate = /^(0(\.\d+)?|1(\.0+)?)$/.test(v ?? "") ? Number(v) : NaN;
      if (!(out.minKillRate >= 0 && out.minKillRate <= 1)) throw new Error(`--min-kill-rate must be a number from 0 to 1: ${v}`);
    } else if (a === "--keep") out.keep = true;
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
  if (!relative.endsWith(".sol")) throw new Error(`test must be a .sol file: ${out.test}`);
  out.test = relative.split(path.sep).join("/");
  return out;
}

function listFiles(root) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) throw new Error(`symlink forbidden: ${path.relative(root, full)}`);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  })(root);
  return out.sort();
}

function treeHash(root) {
  return sha256(listFiles(root).map((rel) => `${rel}\0${sha256(fs.readFileSync(path.join(root, rel)))}\n`).join(""));
}

// Copy only Solidity sources. foundry.toml, remappings.txt, .env and the
// project's lib/forge-std are never copied, so they cannot change the build.
function copySolidity(src, dest) {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(src, full).split(path.sep).join("/");
      if (e.isSymbolicLink()) throw new Error(`project symlink forbidden: ${rel}`);
      if (e.isDirectory()) {
        if (SKIP.has(rel.split("/")[0]) || rel === "lib/forge-std") continue;
        walk(full);
      } else if (e.isFile() && rel.endsWith(".sol")) {
        files.push(rel);
      }
    }
  })(src);
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(path.join(src, rel), path.join(dest, rel));
  }
  return files;
}

// Copy a gate workspace (sources and the gate's foundry.toml, no build output).
function copyWorkspace(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(src, p);
      if (!rel) return true;
      if (SKIP.has(rel.split(path.sep)[0])) return false;
      if (fs.lstatSync(p).isSymbolicLink()) throw new Error(`workspace symlink forbidden: ${rel}`);
      return true;
    },
  });
}

// The gate's own config. Written into every workspace, for every run.
function gateConfig() {
  return [
    "[profile.default]",
    'src = "src"',
    'test = "test"',
    'script = "script"',
    'out = "out"',
    "libs = []",
    "auto_detect_remappings = false",
    `remappings = ["forge-std/=${FORGE_STD.mount}/"]`,
    `allow_paths = ["${path.posix.dirname(FORGE_STD.mount)}"]`,
    "ffi = false",
    "fs_permissions = []",
    `solc = "${SOLC}"`,
    "offline = true",
    "optimizer = false",
    "via_ir = false",
    // Forge 1.9 otherwise rewrites `new X()` in tests into vm.deployCode calls.
    "dynamic_test_linking = false",
    'extra_output = ["storageLayout"]',
    "",
    "[lint]",
    "lint_on_build = false",
    "",
    "[invariant]",
    `runs = ${CAMPAIGN.score.runs}`,
    `depth = ${CAMPAIGN.score.depth}`,
    "fail_on_revert = false",
    "",
  ].join("\n");
}

function writeConfig(ws) {
  fs.writeFileSync(path.join(ws, "foundry.toml"), gateConfig());
}

// The facts the verdict reports, read back from a written foundry.toml.
function configFacts(file) {
  const keys = new Map();
  let section = null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const head = line.match(/^\[(.+)\]$/);
    if (head) section = head[1];
    const kv = line.match(/^(\w+) = (.*)$/);
    if (kv && section === "profile.default") keys.set(kv[1], kv[2]);
  }
  const json = (v) => { try { return JSON.parse(v); } catch { return v ?? null; } };
  return {
    ffi: json(keys.get("ffi")), fs_permissions: json(keys.get("fs_permissions")),
    offline: json(keys.get("offline")), dynamic_test_linking: json(keys.get("dynamic_test_linking")),
    solc: json(keys.get("solc")),
  };
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

let forgeStdMount = null; // verified host copy of the pinned forge-std, mounted read-only

// Every forge call goes through runTool: pinned image, --pull=never,
// --network none, no capabilities, host user. The pinned forge-std is a
// read-only extra mount; the solc cache is a named volume. The host-path
// mount keeps a Daytona call on this host (planRemote), which is intended.
async function forge(ws, argv, { runs = CAMPAIGN.score.runs, depth = CAMPAIGN.score.depth, timeoutMs = 300_000 } = {}) {
  const volume = svmVolume();
  return runTool({
    image: IMAGE, entrypoint: "forge", cmd: argv, ws, network: "none", timeoutMs,
    env: { FOUNDRY_INVARIANT_RUNS: runs, FOUNDRY_INVARIANT_DEPTH: depth },
    mounts: [[forgeStdMount, FORGE_STD.mount, "ro"], ...(volume ? [[volume, "/home/foundry/.svm"]] : [])],
  });
}

function compilerErrors(run) {
  // Show pinned forge-std paths as the import the author wrote (forge-std/X.sol).
  const text = `${run.stderr}\n${run.stdout}`.replace(/\x1b\[[0-9;]*m/g, "").split(`${FORGE_STD.mount}/`).join("forge-std/");
  const lines = text.split("\n").filter((l) => /Error|not found|-->/.test(l)).slice(0, 6);
  return (lines.length ? lines : text.trim().split("\n").slice(-4)).join(" ").replace(/\s+/g, " ").slice(0, 900);
}

const BUILD_NOTE = "The gate ignores the project's foundry.toml and remappings.txt; " +
  `project lib/forge-std is ignored and forge-std/ resolves to the pinned forge-std ${FORGE_STD.version}.`;

async function buildInfo(ws, paths = []) {
  fs.rmSync(path.join(ws, "out"), { recursive: true, force: true });
  fs.rmSync(path.join(ws, "cache"), { recursive: true, force: true });
  const run = await forge(ws, ["build", "--build-info", "--force", ...paths]);
  if (run.code !== 0 || run.timedOut) return { error: `build: forge build failed (${compilerErrors(run)}). ${BUILD_NOTE}` };
  const dir = path.join(ws, "out", "build-info");
  const sources = new Map(); // path -> { content, ast }
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const info = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    if (info.solcVersion && info.solcVersion !== SOLC) return { error: `build: unexpected solc ${info.solcVersion}` };
    for (const [p, s] of Object.entries(info.input?.sources ?? {})) {
      const ast = info.output?.sources?.[p]?.ast;
      if (typeof s.content !== "string" || !ast) return { error: `build: build info lacks source or AST for ${p}` };
      sources.set(p, { content: s.content, ast });
    }
  }
  if (!sources.size) return { error: "build: no build info written" };
  return { sources };
}

// Every compiled source must be either the pinned forge-std or a plain
// project-relative path. Returns an error string or null.
function checkSources(sources) {
  for (const [p, s] of sources) {
    if (p.startsWith(`${FORGE_STD.mount}/`)) {
      const local = path.join(forgeStdMount, p.slice(FORGE_STD.mount.length + 1));
      if (!fs.existsSync(local) || fs.readFileSync(local, "utf8") !== s.content) return `build: ${p} is not the pinned forge-std file`;
      continue;
    }
    if (path.posix.isAbsolute(p) || p.split("/").includes("..") || p.startsWith("./")) return `build: compiled source outside the project: ${p}`;
    if (p === "lib/forge-std" || p.startsWith("lib/forge-std/")) return `build: project lib/forge-std must not be compiled: ${p}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scan: read the solc AST of every compiled project source. Strings and
// comments are not code in the AST, so they cannot hide or fake an access.

const YUL_BANNED = new Map([
  ["extcodesize", "code access"], ["extcodehash", "code access"], ["extcodecopy", "code access"],
  ["codesize", "code access"], ["codecopy", "code access"], ["gas", "gas read"],
]);
// Groups of Vm cheatcodes. Matched against every function name declared in the pinned Vm.sol.
const CHEAT_GROUPS = [
  /code/i, /^read/i, /ffi/i, /^random/i, /^env/i, /gas/i, /^setEnv$/, /^unixTime$/, /^prompt/,
  /^exists$/, /^is(File|Dir)$/, /^fsMetadata$/, /^projectRoot$/, /^write/, /^copyFile$/, /^remove/,
  /^createDir$/, /^closeFile$/, /^getArtifactPath/, /^getDeployment/, /^getBroadcast/, /^rpc/,
  /^sleep$/, /^getFoundryVersion$/,
];
const isCodeName = (name) => /code/i.test(name) && !/^(en|de)code/i.test(name);

function walkAst(node, visit, ctx = { fn: null }) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walkAst(n, visit, ctx);
    return;
  }
  let inner = ctx;
  if (node.nodeType === "FunctionDefinition" || node.nodeType === "ModifierDefinition") inner = { fn: node.id };
  if (node.nodeType) visit(node, inner);
  for (const [key, value] of Object.entries(node)) {
    if (key !== "typeDescriptions" && value && typeof value === "object") walkAst(value, visit, inner);
  }
}

function lineOf(content, src) {
  const start = Number(String(src ?? "").split(":")[0]);
  if (!Number.isFinite(start)) return 0;
  return Buffer.from(content).subarray(0, start).toString("utf8").split("\n").length;
}

function scanSources(sources) {
  const isVendor = (p) => p.startsWith(`${FORGE_STD.mount}/`);
  // Cheat names declared by the pinned Vm interfaces.
  const bannedCheats = new Set();
  const bannedIds = new Map(); // declaration id -> description
  const vm = sources.get(`${FORGE_STD.mount}/Vm.sol`);
  if (vm) walkAst(vm.ast, (n) => {
    if (n.nodeType === "FunctionDefinition" && CHEAT_GROUPS.some((re) => re.test(n.name))) {
      bannedCheats.add(n.name);
      bannedIds.set(n.id, `cheatcode \`vm.${n.name}\``);
    }
  });

  function direct(n) {
    if (n.nodeType === "MemberAccess") {
      const name = n.memberName;
      if (isCodeName(name)) return { what: `code access \`.${name}\`` };
      if (bannedCheats.has(name)) return { what: `cheatcode \`${name}\`` };
      const type = n.expression?.typeDescriptions?.typeString ?? "";
      if (/^contract (Vm|VmSafe)$/.test(type) && CHEAT_GROUPS.some((re) => re.test(name))) return { what: `cheatcode \`vm.${name}\`` };
    }
    if (n.nodeType === "Identifier" && n.name === "gasleft" && n.referencedDeclaration < 0) return { what: "gas read `gasleft()`", gas: true };
    if (n.nodeType === "YulFunctionCall") {
      const name = n.functionName?.name;
      if (YUL_BANNED.has(name)) return { what: `${YUL_BANNED.get(name)} \`${name}\` in inline assembly`, gas: name === "gas" };
    }
    return null;
  }

  // Taint: a forge-std function that reads code, files, env or randomness, or
  // calls one that does. Gas reads alone do not taint (console.log uses gas()).
  const fnDirect = new Map(), fnRefs = new Map(), fnName = new Map();
  for (const [p, s] of sources) {
    if (!isVendor(p)) continue;
    walkAst(s.ast, (n, ctx) => {
      if (n.nodeType === "FunctionDefinition" || n.nodeType === "ModifierDefinition") fnName.set(n.id, n.name);
      if (ctx.fn == null) return;
      const hit = direct(n);
      if (hit && !hit.gas) fnDirect.set(ctx.fn, true);
      if (Number.isInteger(n.referencedDeclaration) && n.referencedDeclaration >= 0) {
        if (!fnRefs.has(ctx.fn)) fnRefs.set(ctx.fn, new Set());
        fnRefs.get(ctx.fn).add(n.referencedDeclaration);
      }
    });
  }
  const tainted = new Set([...fnDirect.keys(), ...bannedIds.keys()]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [fn, refs] of fnRefs) {
      if (!tainted.has(fn) && [...refs].some((r) => tainted.has(r))) {
        tainted.add(fn);
        changed = true;
      }
    }
  }

  const findings = [];
  const scanned = [];
  for (const [p, s] of sources) {
    if (isVendor(p)) continue;
    scanned.push(p);
    walkAst(s.ast, (n) => {
      let hit = direct(n);
      const ref = n.referencedDeclaration;
      if (!hit && (n.nodeType === "Identifier" || n.nodeType === "MemberAccess") && tainted.has(ref)) {
        hit = { what: bannedIds.get(ref) ?? `forge-std helper \`${fnName.get(ref) ?? n.name ?? n.memberName}\` (reads code, files, env or randomness)` };
      }
      if (hit) findings.push(`${hit.what} at ${p}:${lineOf(s.content, n.src)}`);
    });
  }
  return { sources: scanned.sort(), findings: [...new Set(findings)] };
}

// Every invariant_* function in the test file, in source order. All of them are scored.
function invariantNames(sources, test) {
  const unit = sources.get(test);
  const found = [];
  if (unit) walkAst(unit.ast, (n) => {
    if (n.nodeType === "FunctionDefinition" && /^invariant_\w*$/.test(n.name ?? "")) found.push({ name: n.name, at: Number(n.src.split(":")[0]) });
  });
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.name))];
}

// ---------------------------------------------------------------------------
// Differential: build B is FeeVault with the same behavior and different bytes.
//
// Transform (source level):
//   - leading 4-space indentation becomes tabs (whitespace only)
//   - a random trailing comment (changes the metadata hash)
//   - 1-3 pads at the start of every function and receive body:
//       assembly { if lt(0x<random literal>, 0) { invalid() } }
//     `lt(x, 0)` is false for every uint256 x, so the body never runs.
//     solc (optimizer off) emits exactly:
//       PUSH0  PUSHn lit  LT  ISZERO  PUSH2 T  JUMPI  INVALID  T: JUMPDEST
//     The jump is always taken, the stack is unchanged, and nothing touches
//     memory, storage, logs, calls or returndata. Only gas and code bytes change.
//     (A plain `pop(lit)` is not used: solc's peephole pass deletes PUSH+POP.)
const PAD = /[ ]assembly \{ if lt\(0x([0-9a-f]+), 0\) \{ invalid\(\) \} \}/g;
const NONCE = /\n\/\/ vacuity-gate behavior-equal variant [0-9a-f]{16}\n$/;

function variant(text) {
  const pads = [];
  const pad = () => {
    const bytes = crypto.randomBytes(4 + crypto.randomInt(29)); // 4..32 bytes
    if (bytes[0] === 0) bytes[0] = 1; // keeps PUSHn width equal to the literal width
    const hex = bytes.toString("hex");
    pads.push(hex);
    return ` assembly { if lt(0x${hex}, 0) { invalid() } }`;
  };
  let out = text.replace(/^((?: {4})+)/gm, (m) => "\t".repeat(m.length / 4));
  out = out.replace(/^([ \t]*(?:function\s[^;{]*|receive\s*\(\s*\)\s*external\s+payable\s*)\{)/gm,
    (m) => `${m}${Array.from({ length: 1 + crypto.randomInt(3) }, pad).join("")}`);
  out += `\n// vacuity-gate behavior-equal variant ${crypto.randomBytes(8).toString("hex")}\n`;
  // Inverse check: removing exactly the pads, comment and tabs must give the input back.
  const back = out.replace(PAD, "").replace(NONCE, "").replace(/^(\t+)/gm, (m) => "    ".repeat(m.length));
  if (back !== text || !pads.length) throw new Error("source transform is not exactly invertible");
  return { text: out, pads };
}

function disassemble(hex) {
  const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
  const out = [];
  for (let pc = 0; pc < b.length;) {
    const op = b[pc];
    const n = op >= 0x60 && op <= 0x7f ? op - 0x5f : 0;
    if (pc + 1 + n > b.length) throw new Error(`truncated PUSH at ${pc}`);
    out.push({ pc, op, imm: n ? b.subarray(pc + 1, pc + 1 + n).toString("hex") : null });
    pc += 1 + n;
  }
  return out;
}

function stripMetadata(hex) {
  const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
  const len = b.readUInt16BE(b.length - 2);
  if (len + 2 > b.length) throw new Error("runtime has no CBOR metadata trailer");
  const cbor = b[b.length - 2 - len];
  if (cbor < 0xa1 || cbor > 0xb7) throw new Error("runtime has no CBOR metadata trailer");
  return b.subarray(0, b.length - 2 - len).toString("hex");
}

// Remove exactly the pad blocks listed in `pads` (a multiset). Each must match
// the 8-instruction pattern above, with T the pc of its own JUMPDEST.
function removePads(ins, pads) {
  const left = new Map();
  for (const p of pads) left.set(p, (left.get(p) ?? 0) + 1);
  const kept = [], removedTargets = new Set();
  let removed = 0;
  for (let i = 0; i < ins.length; i++) {
    const w = ins.slice(i, i + 8);
    const isPad = w.length === 8 && w[0].op === 0x5f && w[1].imm && left.get(w[1].imm) > 0 &&
      w[2].op === 0x10 && w[3].op === 0x15 && w[4].imm && w[5].op === 0x57 && w[6].op === 0xfe &&
      w[7].op === 0x5b && parseInt(w[4].imm, 16) === w[7].pc;
    if (isPad) {
      left.set(w[1].imm, left.get(w[1].imm) - 1);
      removedTargets.add(w[7].pc);
      removed++;
      i += 7;
      continue;
    }
    kept.push(ins[i]);
  }
  if ([...left.values()].some((n) => n !== 0)) throw new Error("an inserted pad was not found as the exact no-op pattern");
  for (const x of kept) {
    if (x.imm && removedTargets.has(parseInt(x.imm, 16)) && x.imm.length <= 8) throw ambiguous(`a value outside the pads equals a pad JUMPDEST offset (pc ${x.pc})`);
  }
  return { kept, removed };
}

// A coincidence the bytecode alone cannot settle: a value that is a JUMPDEST
// offset in one build only. It may be data or a jump target. The gate does not
// guess; it retries with fresh random pads.
function ambiguous(msg) {
  return Object.assign(new Error(msg), { retry: true });
}

// Compare two instruction lists. Opcodes must be equal. For each PUSH:
//   - equal values that point to the same JUMPDEST index (or to none): equal
//   - different values: both must be JUMPDEST offsets with the same index.
//     (In solc output the only runtime values that depend on code layout are
//     jump targets; CODECOPY and immutables are rejected separately.)
//   - equal values that are a JUMPDEST in only one build: ambiguous, retry.
// `tokens` names values that may differ (code length, code offset).
function compareCode(label, a, b, tokensA = new Map(), tokensB = new Map()) {
  const jd = (list) => new Map(list.filter((x) => x.op === 0x5b).map((x, i) => [x.pc, i]));
  const ja = jd(a), jb = jd(b);
  if (a.length !== b.length) throw new Error(`${label}: ${a.length} vs ${b.length} instructions after removing pads`);
  let relabeled = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.op !== y.op) throw new Error(`${label}: instruction ${i} opcode ${x.op.toString(16)} vs ${y.op.toString(16)}`);
    if (x.imm == null) continue;
    const va = BigInt(`0x${x.imm}`), vb = BigInt(`0x${y.imm}`);
    if (tokensA.has(va) || tokensB.has(vb)) {
      if (tokensA.get(va) !== tokensB.get(vb)) throw new Error(`${label}: instruction ${i} value ${va} vs ${vb}`);
      continue;
    }
    const pa = va < 0x10000n ? ja.get(Number(va)) : undefined, pb = vb < 0x10000n ? jb.get(Number(vb)) : undefined;
    if (va === vb) {
      if (pa !== pb) throw ambiguous(`${label}: instruction ${i} value 0x${x.imm} is JUMPDEST J${pa} in A but J${pb} in B`);
      continue;
    }
    if (pa === undefined || pa !== pb) throw new Error(`${label}: instruction ${i} value 0x${x.imm} vs 0x${y.imm}`);
    relabeled++;
  }
  return relabeled;
}

const CODE_READS = new Set([0x38, 0x39, 0x3b, 0x3c, 0x3f]); // CODESIZE CODECOPY EXTCODESIZE EXTCODECOPY EXTCODEHASH

// Mechanical proof that B differs from A only by the pads, jump offsets,
// code length and metadata. Throws with the first difference.
function proveEqual(a, b, pads) {
  if (JSON.stringify(a.abi) !== JSON.stringify(b.abi)) throw new Error("ABI differs");
  if (JSON.stringify(a.methodIdentifiers) !== JSON.stringify(b.methodIdentifiers)) throw new Error("selectors differ");
  if (!a.storageLayout?.storage || layout(a) !== layout(b)) throw new Error("storage layout differs or is missing");
  const runtime = (x) => x.deployedBytecode.object.replace(/^0x/, "");
  const creation = (x) => x.bytecode.object.replace(/^0x/, "");
  if (runtime(a) === runtime(b)) throw new Error("B has the same runtime bytes as A");
  if (a.deployedBytecode.immutableReferences && Object.keys(a.deployedBytecode.immutableReferences).length) throw new Error("immutables are not supported");
  const ra = disassemble(stripMetadata(runtime(a)));
  const rb = disassemble(stripMetadata(runtime(b)));
  const aImm = new Set(ra.map((x) => x.imm).filter(Boolean));
  if (pads.some((p) => aImm.has(p))) throw new Error("a pad literal also occurs in A");
  const { kept, removed } = removePads(rb, pads);
  if (ra.some((x) => CODE_READS.has(x.op)) || kept.some((x) => CODE_READS.has(x.op))) {
    throw new Error("runtime reads code; byte changes could change behavior");
  }
  const relabeled = compareCode("runtime", ra, kept);
  // Creation code = init code + runtime. Only the runtime length and offset may differ.
  const init = (x) => {
    const c = creation(x), r = runtime(x);
    if (!c.endsWith(r)) throw new Error("creation code does not end with the runtime");
    const initHex = c.slice(0, c.length - r.length);
    return { ins: disassemble(initHex), tokens: new Map([[BigInt(r.length / 2), "RUNTIME_LEN"], [BigInt(initHex.length / 2), "INIT_LEN"]]) };
  };
  const ia = init(a), ib = init(b);
  compareCode("constructor", ia.ins, ib.ins, ia.tokens, ib.tokens);
  return {
    abi: "equal", selectors: "equal", storageLayout: "equal (label, slot, offset, type)",
    runtime: `equal after removing ${removed} pad blocks (${pads.length} inserted); ${ra.length} instructions compared; ${relabeled} jump-target operands matched by JUMPDEST index`,
    constructor: "equal except runtime length and offset operands",
    metadata: "differs (CBOR trailer excluded from the comparison)",
    source: "removing the pads, the trailing comment and the tabs gives the input text back exactly",
  };
}

function artifact(ws) {
  const file = path.join(ws, "out", path.basename(TARGET.path), `${TARGET.contract}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function layout(a) {
  const types = a.storageLayout?.types ?? {};
  return JSON.stringify((a.storageLayout?.storage ?? []).map((s) => [s.label, s.slot, s.offset, types[s.type]?.label ?? s.type]));
}

// Mechanical proof that B differs from A only by the inserted no-ops,
// jump offsets, code length and metadata. Throws with the first difference.
function artifactSummary(a) {
  const r = a.deployedBytecode.object.replace(/^0x/, "");
  return { runtimeSize: r.length / 2, runtimeHash: `sha256:${sha256(Buffer.from(r, "hex"))}` };
}

// ---------------------------------------------------------------------------
// Forge runs. Every run uses the gate config, the fixed seed and the same
// invariant selection; only runs and depth change between profiles.

async function runSuite(ws, test, invariants, profile, { debug = false } = {}) {
  const dir = path.join(ws, ".vacuity-gate");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "results.json");
  fs.rmSync(file, { force: true });
  const argv = ["test", "--match-path", test, "--match-test", `^(${invariants.join("|")})\\(`, "--fuzz-seed", SEED,
    "--json-file", ".vacuity-gate/results.json"];
  if (debug) argv.push("--debug", "--dump", ".vacuity-gate/dump");
  const run = await forge(ws, argv, { ...profile, timeoutMs: 600_000 });
  let results = null;
  try {
    results = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  const statuses = invariantStatuses({ ...run, results });
  return { ...run, results, statuses };
}

async function build(ws) {
  const run = await forge(ws, ["build", "--force"]);
  return run.code === 0 && !run.timedOut ? null : compilerErrors(run);
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
    // Forge 1.9 checks several matched invariants in one campaign. It reports
    // one aggregate test plus one predicate result per invariant. The
    // aggregate name is one of the invariants, so only the predicates count.
    const predicates = tr.invariant_predicate_results ?? [];
    if (!predicates.length) {
      statuses.set(name, tr.status);
      continue;
    }
    for (const p of predicates) {
      if (!["Success", "Failure"].includes(p.status)) return null;
      statuses.set(`${p.name}()`, p.status);
    }
    // The aggregate must agree with its predicates, else the result is not trusted.
    if ((tr.status === "Failure") !== predicates.some((p) => p.status === "Failure")) return null;
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
        const row = bySelector.get(sel) ?? { selector: sel, calls: 0, successes: 0, reverts: 0 };
        row.calls++;
        // The target's code ran and refused the call (require, custom error, panic).
        if (c.status === "Revert") row.reverts++;
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
  // A selector with no committed success is allowed only when the target ran
  // and refused it (an access-control or input probe). A call that never ran
  // the target's code (OutOfFunds, OutOfGas, call depth) or that only
  // succeeded inside a rolled-back frame is a dead action.
  const neverRan = dead.filter((r) => r.reverts === 0);
  const probes = dead.filter((r) => r.reverts > 0);
  const reasons = [];
  // Forge may append one debugger replay action beyond the recorded metrics.
  if (!handlerCalls || tracedActions < handlerCalls || tracedActions > handlerCalls + 1 ||
      Object.entries(metrics).some(([method, m]) => (tracedMethods.get(method) ?? 0) < m.calls)) {
    reasons.push(`liveness: incomplete campaign trace (${tracedActions}/${handlerCalls} actions)`);
  }
  if (targetCalls === 0) reasons.push("liveness: handler never reached the target");
  if (targetCalls && !successfulTargetCalls) reasons.push("liveness: every target call failed or was rolled back");
  if (neverRan.length) reasons.push(`liveness: ${neverRan.length} selector(s) never succeeded and never ran to a revert of their own`);
  if (storageChanges == null) reasons.push("liveness: debugger storage evidence unavailable");
  // Probe selectors are allowed only because other calls change committed state.
  if (!balanceChanges && !storageChanges) {
    reasons.push(`liveness: no committed target balance or storage-value change${probes.length ? ` (${probes.length} selector(s) only reverted)` : ""}`);
  }
  return {
    pass: reasons.length === 0, targetCalls, successfulTargetCalls,
    failedTargetCalls: targetCalls - successfulTargetCalls, successfulValueCalls,
    storageChanges, balanceChanges, handlerCalls, handlerReverts, tracedActions,
    targetCallSuccessRate: targetCalls ? Number((successfulTargetCalls / targetCalls).toFixed(4)) : 0,
    selectors: [...bySelector.values()], deadSelectors: dead.map((r) => r.selector),
    probeSelectors: probes.map((r) => r.selector), reasons,
  };
}


// The scored target is the deployed contract named FeeVault from src/FeeVault.sol.
function resolveTarget(dumpDir, testPath, results) {
  const list = contracts(dumpDir);
  const testDir = path.dirname(testPath);
  const inTestDir = (c) => declaredSources(dumpDir, c).some((f) => f === testDir || f.startsWith(`${testDir}/`));
  const testContract = list.find((c) => c.name === path.basename(testPath, ".t.sol"));
  const handlers = new Set(list.filter((c) => c !== testContract && inTestDir(c)).map((c) => c.address));
  const candidates = list.filter((c) => c.name === TARGET.contract && declaredSources(dumpDir, c).includes(TARGET.path));
  let best = null;
  for (const c of candidates) {
    const n = tracedTargetCalls(results, c.address).length;
    if (!best || n > best.n) best = { n, c };
  }
  return { target: best?.c.address ?? null, handlers };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!svmVolume()) throw new Error("no solc cache volume (foundry-svm or touchstone_svm_cache); refusing to use the network");
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
  } catch {
    throw new Error(`preinstalled pinned Forge image missing: ${IMAGE}; refusing to pull`);
  }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vacuity-gate-"));
  const verdict = {
    pass: false,
    environment: {
      image: IMAGE, seed: SEED, campaign: CAMPAIGN,
      // Filled from the foundry.toml the gate writes into the workspace.
      ffi: null, fs_permissions: null, offline: null, dynamic_test_linking: null, solc: null,
      projectConfig: "ignored (foundry.toml, remappings.txt and lib/forge-std are not copied)",
      forgeStd: { version: FORGE_STD.version, treeSha256: null, mount: `${FORGE_STD.mount} (read-only)` },
    },
    target: { path: TARGET.path, contract: TARGET.contract, pinnedSha256: TARGET.sha256, sha256: null },
    scan: { sources: [], findings: [] },
    differential: { pass: false, builds: [], proof: null, failing: [] },
    campaign: {},
    liveness: { pass: false, reasons: [] },
    mutants: [],
    killRate: 0,
    minKillRate: opts.minKillRate,
    survivingMutants: [],
    unscoredMutants: [],
    knownBug: { planted: "rescue() without onlyOwner", detected: false, failingInvariants: [] },
    reasons: [],
  };
  const fail = (reason) => {
    verdict.reasons.push(reason);
    return verdict;
  };

  try {
    // 1. Environment: verified copy of the pinned forge-std, mounted read-only.
    forgeStdMount = path.join(base, "forge-std");
    fs.cpSync(FORGE_STD.dir, forgeStdMount, { recursive: true });
    const stdHash = treeHash(forgeStdMount);
    verdict.environment.forgeStd.treeSha256 = stdHash;
    if (stdHash !== FORGE_STD.treeSha256) return fail(`environment: vendored forge-std tree ${stdHash} is not the pinned ${FORGE_STD.treeSha256}`);

    // 2. Target: src/FeeVault.sol with the pinned hash.
    const original = path.join(opts.project, TARGET.path);
    if (!fs.existsSync(original) || fs.lstatSync(original).isSymbolicLink()) return fail(`target: ${TARGET.path} is missing`);
    const pinnedText = fs.readFileSync(original, "utf8");
    verdict.target.sha256 = sha256(pinnedText);
    if (verdict.target.sha256 !== TARGET.sha256) {
      return fail(`target: ${TARGET.path} sha256 ${verdict.target.sha256} is not the pinned ${TARGET.sha256}`);
    }

    // 3. Find what solc compiles for the selected test, under the gate config.
    log(`staging Solidity sources from ${opts.project}`);
    const stage = path.join(base, "stage");
    copySolidity(opts.project, stage);
    writeConfig(stage);
    const closure = await buildInfo(stage, [opts.test]);
    if (closure.error) return fail(closure.error);
    const bad = checkSources(closure.sources);
    if (bad) return fail(bad);
    if (!closure.sources.has(TARGET.path)) return fail(`target: the selected test does not compile ${TARGET.path}`);
    if (!closure.sources.has(opts.test)) return fail(`build: build info does not contain ${opts.test}`);

    // 4. The workspace holds only those sources and the gate config.
    const ws = path.join(base, "A");
    const projectFiles = [...closure.sources.keys()].filter((p) => !p.startsWith(`${FORGE_STD.mount}/`));
    for (const rel of projectFiles) {
      fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
      fs.copyFileSync(path.join(stage, rel), path.join(ws, rel));
    }
    writeConfig(ws);
    Object.assign(verdict.environment, configFacts(path.join(ws, "foundry.toml")));
    const env = verdict.environment;
    if (env.ffi !== false || !Array.isArray(env.fs_permissions) || env.fs_permissions.length || env.offline !== true) {
      return fail("environment: the gate config must set ffi = false, fs_permissions = [] and offline = true");
    }
    if (pinnedText.split(REPAIR.find).length !== 2) return fail("known-bug: reference repair pattern must occur exactly once");
    const healthyText = pinnedText.replace(REPAIR.find, REPAIR.replace);
    fs.writeFileSync(path.join(ws, TARGET.path), healthyText);
    const full = await buildInfo(ws);
    if (full.error) return fail(full.error);
    const fullBad = checkSources(full.sources);
    if (fullBad) return fail(fullBad);
    const same = full.sources.size === closure.sources.size && [...full.sources.keys()].every((p) => closure.sources.has(p));
    if (!same) return fail(`build: compiled source set changed between staging and workspace (${[...full.sources.keys()].sort().join(", ")})`);

    // 5. Scan the solc AST of every compiled project source.
    verdict.scan = scanSources(full.sources);
    log(`scan: ${verdict.scan.sources.length} project sources, ${verdict.scan.findings.length} findings`);
    if (verdict.scan.findings.length) {
      for (const f of verdict.scan.findings) verdict.reasons.push(`scan: banned ${f}`);
      return verdict;
    }
    const invariants = invariantNames(full.sources, opts.test);
    if (!invariants.length) return fail("control: no invariant function found");
    verdict.campaign.invariants = invariants;
    // forge --debug replays exactly one test, so liveness replays the first
    // invariant. The handler calls come from setUp and the seed, not from the
    // invariant, so on the healthy build this is the same call sequence.
    verdict.campaign.livenessInvariant = invariants[0];

    // 6. Build B and prove it is behavior-equal to A.
    const A = artifact(ws);
    let B;
    try {
      B = await paddedBuild(base, ws, "B", healthyText);
    } catch (e) {
      return fail(`differential: could not verify B is behavior-equal: ${e.message}`);
    }
    verdict.differential.builds = [
      { name: "A", description: `healthy ${TARGET.path} (rescue repaired with onlyOwner)`, ...artifactSummary(A) },
      { name: "B", description: "A with tabs for indentation, a random trailing comment, and 1-3 never-taken `assembly { if lt(0x<random>, 0) { invalid() } }` pads at the start of every function and receive body",
        pads: B.pads.length, ...artifactSummary(B.artifact) },
    ];
    verdict.differential.proof = B.proof;

    // 7. Strong healthy campaign on A.
    const prof = (p) => `${p.runs} runs x depth ${p.depth}, seed ${SEED}`;
    log(`control: strong campaign (${prof(CAMPAIGN.strong)})`);
    const strong = await runSuite(ws, opts.test, invariants, CAMPAIGN.strong);
    verdict.campaign.strong = { runs: CAMPAIGN.strong.runs, depth: CAMPAIGN.strong.depth, statuses: Object.fromEntries(strong.statuses ?? []) };
    if (!strong.statuses || strong.code !== 0 || failures(strong.statuses).length) {
      return fail(`control: healthy reference must pass every selected invariant (strong campaign: ${prof(CAMPAIGN.strong)}; no skips or execution errors)`);
    }

    // 8. Scored campaign on A, then the same campaign on B.
    log(`control: scored campaign on A (${prof(CAMPAIGN.score)})`);
    const healthyRun = await runSuite(ws, opts.test, invariants, CAMPAIGN.score);
    const healthy = healthyRun.statuses;
    if (!healthy || healthyRun.code !== 0 || failures(healthy).length) {
      return fail(`control: healthy reference must pass every selected invariant (scored campaign: ${prof(CAMPAIGN.score)}; no skips or execution errors)`);
    }
    log("differential: scored campaign on B");
    const bRun = await runSuite(B.dir, opts.test, invariants, CAMPAIGN.score);
    verdict.differential.statuses = { A: Object.fromEntries(healthy), B: Object.fromEntries(bRun.statuses ?? []) };
    if (!bRun.statuses || bRun.timedOut) {
      return fail(`differential: build B gave no complete result for the selected invariants (incomplete campaign or execution error)`);
    }
    verdict.differential.failing = failures(bRun.statuses).filter((n) => healthy.get(n) === "Success");
    if (verdict.differential.failing.length || bRun.code !== 0) {
      return fail(`differential: ${verdict.differential.failing.join(", ") || "a selected invariant"} passes on healthy build A but fails on behavior-equal build B ` +
        `(A ${verdict.differential.builds[0].runtimeHash} vs B ${verdict.differential.builds[1].runtimeHash}; fingerprint oracle or too-strict/flaky invariant)`);
    }
    verdict.differential.pass = true;

    // 9. Liveness from one replayed campaign on A.
    log("liveness: one debug campaign on A");
    const debugRun = await runSuite(ws, opts.test, [invariants[0]], CAMPAIGN.debug, { debug: true });
    const dumpDir = path.join(ws, ".vacuity-gate", "dump");
    if (!debugRun.statuses || debugRun.code !== 0) return fail("liveness: debug campaign on the healthy reference did not complete");
    const { target, handlers } = resolveTarget(dumpDir, opts.test, debugRun.results);
    if (!target) {
      verdict.liveness = { pass: false, reasons: [`target: the suite does not deploy ${TARGET.path}:${TARGET.contract}`] };
      return fail(verdict.liveness.reasons[0]);
    }
    verdict.target.address = target;
    const handlerMethods = new Map();
    for (const c of contracts(dumpDir).filter((c) => handlers.has(c.address))) {
      const methods = await inspectSelectors(ws, `${opts.test}:${c.name}`);
      handlerMethods.set(c.address.toLowerCase(), new Map([...methods].map(([selector, signature]) =>
        [selector, `${opts.test}:${c.name}.${signature.split("(")[0]}`])));
    }
    verdict.liveness = livenessCheck({ dumpDir, results: debugRun.results, target,
      handlers: new Set([...handlers].map((h) => h.toLowerCase())), handlerMethods });
    const names = await inspectSelectors(ws, `${TARGET.path}:${TARGET.contract}`);
    for (const row of verdict.liveness.selectors) row.name = names.get(row.selector) ?? null;
    verdict.liveness.deadSelectors = verdict.liveness.deadSelectors.map((s) => names.get(s) ?? s);
    verdict.liveness.probeSelectors = verdict.liveness.probeSelectors.map((s) => names.get(s) ?? s);
    if (!verdict.liveness.pass) {
      verdict.reasons.push(...verdict.liveness.reasons);
      return verdict;
    }

    // 10. Known bug and mutants. Each is padded with fresh random no-ops, and
    // the padding is proven against an unpadded build of the same text.
    const scored = async (label, text) => {
      const built = await paddedBuild(base, ws, label, text);
      const run = await runSuite(built.dir, opts.test, invariants, CAMPAIGN.score);
      const failing = failures(run.statuses).filter((n) => healthy.get(n) === "Success");
      return { killed: Boolean(run.statuses && run.code === 1 && !run.timedOut && failing.length), failing, runtimeHash: artifactSummary(built.artifact).runtimeHash };
    };
    try {
      const r = await scored("buggy", pinnedText);
      verdict.knownBug.failingInvariants = r.failing;
      verdict.knownBug.detected = r.killed;
      verdict.knownBug.runtimeHash = r.runtimeHash;
    } catch (e) {
      verdict.knownBug.error = e.message;
    }
    if (!verdict.knownBug.detected) verdict.reasons.push("known-bug: no new invariant Failure against the repaired reference");
    log(`mutants: ${MUTANTS.length} against ${TARGET.path}`);
    for (const mutant of MUTANTS) {
      const hits = healthyText.split(mutant.find).length - 1;
      const entry = { id: mutant.id, applied: hits === 1, compiled: false, killed: false };
      verdict.mutants.push(entry);
      if (hits !== 1) continue;
      try {
        const r = await scored(`mutant-${mutant.id}`, healthyText.replace(mutant.find, mutant.replace));
        Object.assign(entry, { compiled: true, killed: r.killed, failingInvariants: r.failing, runtimeHash: r.runtimeHash });
      } catch (e) {
        entry.error = e.message;
      }
      log(`${mutant.id}: ${entry.killed ? "killed" : entry.compiled ? "survived" : "not scored"}`);
    }
    const applied = verdict.mutants.filter((m) => m.applied && m.compiled);
    const killed = applied.filter((m) => m.killed);
    const rate = applied.length ? killed.length / applied.length : 0;
    verdict.killRate = Number(rate.toFixed(4));
    verdict.survivingMutants = applied.filter((m) => !m.killed).map((m) => m.id);
    verdict.unscoredMutants = verdict.mutants.filter((m) => !(m.applied && m.compiled)).map((m) => m.id);
    const survived = verdict.survivingMutants.length ? ` (survived: ${verdict.survivingMutants.join(", ")})` : "";
    if (killed.length === 0) verdict.reasons.push(`mutants: killed 0 of ${applied.length} applied mutants`);
    else if (rate < opts.minKillRate) {
      verdict.reasons.push(`mutants: kill rate ${verdict.killRate} (${killed.length} of ${applied.length}) is below --min-kill-rate ${opts.minKillRate}${survived}`);
    }

    verdict.pass = verdict.liveness.pass && verdict.differential.pass && killed.length > 0 && rate >= opts.minKillRate &&
      verdict.knownBug.detected && verdict.reasons.length === 0;
    return verdict;
  } finally {
    if (opts.keep) log(`kept ${base}`);
    else fs.rmSync(base, { recursive: true, force: true });
  }
}

// Build `text` as src/FeeVault.sol twice: plain and padded with fresh random
// pads. Prove the padded build equal to the plain one. Throws on any doubt.
// Only an ambiguous offset coincidence is retried, with new random pads.
const PAD_ATTEMPTS = 8;
async function paddedBuild(base, ws, label, text) {
  const plain = path.join(base, `${label}-plain`);
  const dir = path.join(base, label);
  copyWorkspace(ws, plain);
  copyWorkspace(ws, dir);
  fs.writeFileSync(path.join(plain, TARGET.path), text);
  let v = variant(text);
  fs.writeFileSync(path.join(dir, TARGET.path), v.text);
  const [e1, e2] = await Promise.all([build(plain), build(dir)]);
  if (e1 || e2) throw new Error(`compile failed (${e1 || e2})`);
  const a = artifact(plain);
  const retried = [];
  for (let attempt = 1; ; attempt++) {
    try {
      const proof = proveEqual(a, artifact(dir), v.pads);
      if (retried.length) proof.retries = retried;
      fs.rmSync(plain, { recursive: true, force: true });
      return { dir, pads: v.pads, proof, artifact: artifact(dir) };
    } catch (e) {
      if (!e.retry || attempt >= PAD_ATTEMPTS) throw new Error(`${e.message}${retried.length ? ` (after ${retried.length} retries)` : ""}`);
      retried.push(e.message);
    }
    v = variant(text);
    fs.writeFileSync(path.join(dir, TARGET.path), v.text);
    const err = await build(dir);
    if (err) throw new Error(`compile failed (${err})`);
  }
}

main()
  .then((v) => {
    process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
    process.exitCode = v.pass ? 0 : 1;
  })
  .catch((e) => {
    if (process.env.VACUITY_DEBUG) process.stderr.write(`${e.stack}\n`);
    process.stdout.write(`${JSON.stringify({ pass: false, error: String(e), reasons: [String(e)] }, null, 2)}\n`);
    process.exitCode = 1;
  });
