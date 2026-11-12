// Shared code for the Keys and Chain watch packs. Both packs work the same way:
//
//   1. prepass: a Docker container (the chain-tools image) starts Anvil with no
//      network, deploys the lab, and writes `chain-observation.json` to the run
//      workspace. The pack reads that file and turns it into leads.
//   2. the agent reads the leads and the lab source, then writes a Foundry test
//      that shows the harm. run_poc and submit_finding gate that test.
//   3. prove: the engine replays each submitted test, and a harm check reads the
//      money the replay moved.
//
// A lead is not a finding. Only a replayed test with shown harm is a finding.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { forgeTest, writePoc } from "../../lib/sandbox.mjs";
import { runTool } from "../../lib/wrap.mjs";
import { IMPACT_RANK } from "../../lib/ensemble.mjs";
import { event } from "../../lib/event.mjs";
import { proveFindings } from "../../lib/record.mjs";
import { aderynScan } from "../../lib/aderyn.mjs";
import { labOf, controlChanges } from "./control.mjs";
import { scanSources } from "./source-checks.mjs";

export const IMAGE = "touchstone-chain-tools:wave1";
export const OBSERVATION = "chain-observation.json";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FILE_READ_CAP = 256 * 1024;
const MAX_POC = Number(process.env.MAX_POC ?? 8);

const lc = (value) => String(value ?? "").toLowerCase();
const isZero = (word) => /^0x0*$/.test(String(word ?? "0x"));
const addressOfSlot = (word) => (isZero(word) ? null : `0x${String(word).slice(-40)}`.toLowerCase());
const short = (address) => `${String(address).slice(0, 8)}…${String(address).slice(-4)}`;

// Anvil and Hardhat share one public mnemonic. Their first ten private keys are
// printed in every tutorial. A Safe owner on this list is open to anyone.
export const KNOWN_KEYS = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9", "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
  "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f", "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
].map(lc);

// ---------------------------------------------------------------- the world

let imageReady = null;
function ensureImage() {
  imageReady ??= new Promise((done, fail) => {
    execFile("docker", ["image", "inspect", IMAGE], (missing) => {
      if (!missing) return done();
      execFile("docker", ["build", "-q", "-f", "spike/packs/keys/runtime/Dockerfile", "-t", IMAGE, "."],
        { cwd: ROOT, timeout: 900_000 }, (error) => (error ? fail(error) : done()));
    });
  });
  return imageReady;
}

// Run the lab world once. `mode` is "keys" or "chain-watch". Returns the parsed observation.
export async function observe(ws, mode) {
  await ensureImage();
  rmSync(join(ws, OBSERVATION), { force: true });
  const run = await runTool({ image: IMAGE, ws, env: { HOME: "/tmp" }, timeoutMs: 240_000,
    cmd: ["node", "/opt/touchstone/observe.mjs", mode] });
  const file = join(ws, OBSERVATION);
  if (!existsSync(file)) throw new Error(`The ${mode} lab did not write an observation: ${run.stderr.slice(-400)}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

// The lab world needs the lab's own contracts. A real folder has none of them. Then the
// pack runs in source mode: no Anvil, only the source checks and Aderyn.
const WORLD_MARKER = { "keys": "src/KeysLab.sol", "chain-watch": "src/ChainWatchLab.sol" };
export const hasWorld = (ws, mode) => existsSync(join(ws, WORLD_MARKER[mode] ?? "src/none.sol"));

export function readObservation(ws) {
  try { return JSON.parse(readFileSync(join(ws, OBSERVATION), "utf8")); } catch { return null; }
}

// ---------------------------------------------------------------- leads

const rank = (impact) => IMPACT_RANK[impact] ?? 9;

// Merge leads from independent engines. Two leads are the same when they share a
// check, a place and a block. Engines that agree mark the lead `corroborated`.
// Severity leads, then agreement, then the order the leads came in.
export function mergeChain(leads) {
  const byKey = new Map();
  for (const lead of leads) {
    const key = `${lead.check}::${lc(lead.where)}::${lead.block ?? ""}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...lead, engines: [lead.engine] }); continue; }
    if (!prev.engines.includes(lead.engine)) prev.engines.push(lead.engine);
    if (lead.description.length > prev.description.length) prev.description = lead.description;
  }
  return [...byKey.values()]
    .map((lead, order) => ({ ...lead, order, corroborated: lead.engines.length > 1 }))
    .sort((a, b) => rank(a.impact) - rank(b.impact) || Number(b.corroborated) - Number(a.corroborated) || a.order - b.order)
    .map(({ order, ...lead }) => lead);
}

const sameSet = (a, b) => JSON.stringify([...(a ?? [])].map(lc).sort()) === JSON.stringify([...(b ?? [])].map(lc).sort());

// Keys checks. Our own logic over Safe state that two readers returned: plain
// ethers calls, and Safe's own protocol-kit. A fact both readers return is
// marked as agreed by both engines.
export function keysLeads(obs) {
  const leads = [];
  for (const safe of obs.safes ?? []) {
    const sdk = safe.sdk && !safe.sdk.error ? safe.sdk : null;
    const agrees = { threshold: sdk && Number(sdk.threshold) === safe.threshold,
      owners: sdk && sameSet(sdk.owners, safe.owners), modules: sdk && sameSet(sdk.modules, safe.modules) };
    const add = (check, impact, where, description, field) => {
      leads.push({ engine: "Touchstone reader", check, impact, where: lc(where), description });
      if (field && agrees[field]) leads.push({ engine: "Safe SDK", check, impact, where: lc(where), description });
    };
    const label = `Safe "${safe.name}" ${short(safe.address)}`;
    const count = safe.owners.length;
    if (safe.threshold === 1) {
      add("threshold-one", "High", safe.address,
        `${label} needs 1 signature out of ${count} owners. One stolen key moves all funds.`, "threshold");
    } else if (safe.threshold * 2 <= count) {
      add("threshold-below-majority", "Medium", safe.address,
        `${label} needs ${safe.threshold} of ${count} signatures. Less than a majority of owners must agree.`, "threshold");
    }
    safe.owners.forEach((owner) => {
      const slot = KNOWN_KEYS.indexOf(lc(owner));
      if (slot >= 0) {
        add("owner-known-key", "High", owner,
          `${label} has owner ${owner}. This is Anvil/Hardhat test account #${slot}. Its private key is public, so anyone can sign as this owner.`, "owners");
      }
      const code = obs.code?.[lc(owner)];
      if (code?.delegate) {
        add("owner-7702-delegated", "High", owner,
          `${label} has owner ${owner}. This account has EIP-7702 code that delegates to ${code.delegate}. The delegate code runs with the owner's authority, and the account owner can change it at any time.`, "owners");
      } else if (code?.size > 0) {
        add("owner-is-contract", "Low", owner,
          `${label} has owner ${owner}, which is a contract. Its signatures use ERC-1271. Review who controls it.`, "owners");
      }
    });
    for (const module of safe.modules ?? []) {
      const code = obs.code?.[lc(module)];
      add("module-enabled", "High", module,
        `${label} has module ${module} enabled${code ? ` (${code.size} bytes of code)` : ""}. A module spends from the Safe with no owner signature, so the threshold does not apply. Read its access control.`, "modules");
    }
    if ((safe.modules ?? []).length && isZero(safe.guard)) {
      add("no-guard", "Low", safe.address,
        `${label} has modules but no transaction guard. Safe 1.4.1 guards do not check module calls, so nothing can block a module.`);
    }
    if (!isZero(safe.fallbackHandler)) {
      add("fallback-handler-set", "Low", safe.address,
        `${label} routes unknown calls to ${addressOfSlot(safe.fallbackHandler)}. Review that handler.`);
    }
    if (/^1\.(0|1|2)\./.test(safe.version ?? "")) {
      add("old-safe-version", "Medium", safe.address, `${label} runs Safe ${safe.version}, which is older than 1.3.0.`);
    }
  }
  // Signer reuse: one key that guards several Safes ties them together.
  const seen = new Map();
  for (const safe of obs.safes ?? []) for (const owner of safe.owners) {
    seen.set(lc(owner), [...(seen.get(lc(owner)) ?? []), safe.name]);
  }
  for (const [owner, names] of seen) {
    if (names.length > 1) {
      leads.push({ engine: "Touchstone reader", check: "signer-reuse", impact: "Medium", where: owner,
        description: `Owner ${owner} signs for ${names.length} Safes (${names.join(", ")}). One compromise reaches all of them.` });
    }
  }
  return mergeChain(leads);
}

const EVENT_CHECKS = { Upgraded: "implementation-changed", AdminChanged: "admin-changed",
  OwnershipTransferred: "owner-changed", RoleGranted: "role-granted", RoleRevoked: "role-revoked" };

// Chain watch checks. Engine one reads state: it diffs the EIP-1967 slots, the
// owner and the roles between blocks. Engine two is Forta's log filter over the
// same range. A change both see is corroborated. A change only the state diff
// sees (no event) is the one an event-only monitor misses.
export function watchLeads(obs) {
  const leads = [];
  const where = lc(obs.address);
  const changes = []; // { check, block, actor }
  const logsAt = (block, name) => (obs.eventLeads ?? []).some((l) => l.block === block && l.check === name);
  const txFrom = (block) => (obs.transactions ?? []).filter((tx) => tx.block === block && lc(tx.to) === where).map((tx) => lc(tx.from));
  const snaps = obs.snapshots ?? [];
  for (let i = 1; i < snaps.length; i++) {
    const [a, b] = [snaps[i - 1], snaps[i]];
    const flag = (check, impact, event, text, actor) => {
      const silent = event && !logsAt(b.block, event);
      const note = silent ? ` No ${event} event was emitted, so a monitor that reads only events does not see it.` : "";
      leads.push({ engine: "Touchstone slot diff", check, impact, where, block: b.block, silent: Boolean(silent),
        description: `Block ${b.block}: ${text}.${note}` });
      changes.push({ check, block: b.block, actor });
    };
    if (a.implementation !== b.implementation) {
      flag("implementation-changed", "High", "Upgraded",
        `implementation slot changed from ${addressOfSlot(a.implementation)} to ${addressOfSlot(b.implementation)}`, txFrom(b.block)[0]);
    }
    if (a.admin !== b.admin) {
      flag("admin-changed", "High", "AdminChanged",
        `admin slot changed from ${addressOfSlot(a.admin)} to ${addressOfSlot(b.admin)}`, addressOfSlot(b.admin));
    }
    if (lc(a.owner) !== lc(b.owner)) {
      flag("owner-changed", "High", "OwnershipTransferred", `owner changed from ${lc(a.owner)} to ${lc(b.owner)}`, lc(b.owner));
    }
    for (const role of b.roles ?? []) {
      const before = (a.roles ?? []).find((r) => r.role === role.role && lc(r.account) === lc(role.account));
      if (before && before.granted !== role.granted) {
        flag(role.granted ? "role-granted" : "role-revoked", role.granted ? "High" : "Low", role.granted ? "RoleGranted" : "RoleRevoked",
          `role ${short(role.role)} ${role.granted ? "granted to" : "revoked from"} ${lc(role.account)}`, lc(role.account));
      }
    }
  }
  for (const lead of obs.eventLeads ?? []) {
    const check = EVENT_CHECKS[lead.check] ?? lead.check;
    const impact = check === "role-revoked" ? "Low" : lead.impact;
    leads.push({ engine: "Forta", check, impact, where: lc(lead.where), block: lead.block, description: lead.description });
  }
  for (const tx of obs.canary?.transactions ?? []) {
    leads.push({ engine: "Touchstone canary", check: "canary-wallet-moved", impact: "High", where: lc(tx.from), block: tx.block,
      description: `Block ${tx.block}: canary wallet ${tx.from} sent ${tx.value} wei to ${tx.to}. Nobody should touch this wallet. Treat its key as stolen.` });
  }
  // Correlation: one address behind several kinds of change.
  const byActor = new Map();
  for (const change of changes) {
    if (!change.actor) continue;
    byActor.set(change.actor, [...(byActor.get(change.actor) ?? []), change]);
  }
  for (const [actor, list] of byActor) {
    const kinds = [...new Set(list.map((c) => c.check))];
    if (kinds.length > 1) {
      leads.push({ engine: "Touchstone slot diff", check: "actor-correlation", impact: "High", where: actor,
        description: `Address ${actor} is behind ${kinds.length} kinds of change on ${obs.address}: ${kinds.join(", ")}. This looks like one attacker taking control step by step.` });
    }
  }
  return mergeChain(leads);
}

export function describeLeads(leads, empty) {
  if (!leads.length) return empty;
  return leads.map((lead, i) => {
    const agree = lead.corroborated ? ` — ${lead.engines.join(" + ")} AGREE (stronger lead)` : ` — seen only by ${lead.engines.join(" + ")}`;
    const block = lead.block != null ? ` block ${lead.block}` : "";
    return `#${i + 1} [${lead.impact}] ${lead.check} at ${lead.where}${block}${agree}\n${lead.description}`;
  }).join("\n\n");
}

// ---------------------------------------------------------------- source leads

// Every .sol file under src/ that is not vendored. Capped so a huge repo stays cheap.
// Vendored means `node_modules` or `vendor` anywhere, or `lib` at the repo root (Foundry
// dependencies). A first-party `src/lib/...` folder is scanned.
const SOURCE_CAP = 400;
export function sourceFiles(ws) {
  return listSol(ws).filter((rel) => !/(^|[\\/])(node_modules|vendor)[\\/]/.test(rel) && !/^lib[\\/]/.test(rel)).slice(0, SOURCE_CAP).map((rel) => {
    let content = "";
    try { content = readFileSync(join(ws, rel), "utf8").slice(0, FILE_READ_CAP); } catch { /* skip unreadable files */ }
    return { path: rel, content };
  });
}

// Our own crypto-gap checks over the source (source-checks.mjs), as chain leads.
export function sourceLeads(ws) {
  return mergeChain(scanSources(sourceFiles(ws)).map((lead) => ({ ...lead, where: `${lead.where} (${lead.file}:${lead.lines[0]})` })));
}

// Aderyn runs through runTool() with no network. Only its High and Medium results
// become leads. It is a second engine for the source, not a verdict.
export async function aderynLeads(ws) {
  let scan;
  try { scan = await aderynScan(ws); } catch (error) { return { available: false, reason: String(error?.message ?? error), leads: [] }; }
  const leads = (scan.leads ?? []).filter((l) => l.impact === "High" || l.impact === "Medium").slice(0, 10)
    .map((l) => ({ engine: "Aderyn", check: l.check, impact: l.impact, where: `${l.file}:${l.lines?.[0] ?? 0}`,
      file: l.file, lines: l.lines ?? [], description: l.description }));
  return { available: scan.available, reason: scan.reason, leads };
}

// Leads for one workspace: the lab world (when there is one) plus the source checks.
export function leadsFor(ws, analyze) {
  const obs = readObservation(ws);
  return [...(obs ? analyze(obs) : []), ...sourceLeads(ws)].sort((a, b) => rank(a.impact) - rank(b.impact)); // stable sort keeps engine order
}

// ---------------------------------------------------------------- harm oracle

// The addresses a run is about: the proxy of Chain watch, the Safes of Keys. An agent
// may rebuild such a contract at its real address with vm.etch. The replay then does not
// see a CREATE, but the contract is still the victim.
export function targetsOf(obs) {
  return labOf(obs, KNOWN_KEYS).targets;
}

// A proof must pass AND show harm. There are two kinds, both read from the replay.
// funds:   a contract lost ETH and some other address gained it. The victim is a contract
//          the test deployed, or a lab target address.
// control: the replay changed who controls a lab target (Safe owners, threshold, modules,
//          guard, fallback handler; EIP-1967 implementation or admin; an EIP-7702
//          delegation on a lab EOA). See control.mjs. A probe that changes nothing fails.
// `lab` is labOf(observation). A plain list of addresses still works as the target list.
export function harmOf(proof, lab = { targets: [], proxy: false, eoas: [] }) {
  if (!proof?.pass) return { ok: false, reason: "the test did not pass on replay" };
  if (Array.isArray(lab)) lab = { targets: lab, proxy: false, eoas: [] };
  const targets = lab.targets.map(lc);
  const rows = proof.transfers ?? [];
  const isVictim = (r) => BigInt(r.netWei) < 0n && (r.label === "Deployed contract" || targets.includes(lc(r.address)));
  const victim = rows.filter(isVictim).sort((a, b) => (BigInt(a.netWei) < BigInt(b.netWei) ? -1 : 1))[0];
  const gainer = rows.filter((r) => r.gained && r.address !== victim?.address).sort((a, b) => (BigInt(a.netWei) > BigInt(b.netWei) ? -1 : 1))[0];
  const changes = controlChanges(proof.controlTrace, lab);
  if (victim && gainer) {
    return { ok: true, kind: "funds", victim: victim.address, attacker: gainer.address, lostWei: victim.netWei, gainedWei: gainer.netWei, ...(changes.length ? { changes } : {}) };
  }
  if (changes.length) return { ok: true, kind: "control", victim: changes[0].target, changes };
  return { ok: false, reason: "the test passed but moved no ETH out of a deployed contract and changed no owner, threshold, module, guard, implementation, admin or delegation of a lab target" };
}

// proveFindings replays each test. Then the harm check decides if the replay is a proof.
// This pack's harmOf replaces the generic verdict, so pocProved is gated on it.
export async function proveWithHarm(ws, found, events, log) {
  const lab = labOf(readObservation(ws), KNOWN_KEYS);
  const findings = await proveFindings(ws, found, events, log, { stateTrace: true, judge: (proof) => harmOf(proof, lab) });
  return findings.map((finding) => {
    if (!finding.proof) return finding;
    // The state trace is large. The harm keeps the changes it found, so drop the trace.
    const { controlTrace, ...proof } = finding.proof;
    return { ...finding, proof };
  });
}

// ---------------------------------------------------------------- tools

function listSol(ws) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = readdirSync(join(ws, rel), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".sol")) out.push(child);
    }
  };
  walk("src");
  return out.sort();
}

function resolveReadable(ws, raw) {
  const name = String(raw).trim();
  for (const abs of [resolve(ws, name), resolve(ws, "src", name)]) {
    const rel = relative(ws, abs);
    if (!rel || rel.startsWith("..") || rel.startsWith(sep) || rel.split(sep)[0] !== "src") continue;
    try { if (statSync(abs).isFile()) return abs; } catch { /* try the next form */ }
  }
  return null;
}

const text = (value, isError = false) => ({ output: [{ type: "text", text: value }], ...(isError ? { isError } : {}) });

// The tool set for one chain pack. `spec`:
//   mode      "keys" | "chain-watch"
//   stateTool { name, description }   returns the lab observation
//   leadsTool { name, description }   returns the ranked leads
//   analyze   (observation) => leads
//   empty     what to say when there are no leads
export function chainTools(ws, state, spec) {
  const listSources = defineTool({
    name: "list_sources", description: "List the Solidity files of the lab under src/.", parameters: obj({}), replay: "safe",
    execute: async () => { event("list_sources"); return text(listSol(ws).join("\n") || "(no Solidity files)"); },
  });
  const readSource = defineTool({
    name: "read_source", description: "Read one lab source file. Pass a path list_sources printed.",
    parameters: obj({ file: str({ description: "a path from list_sources" }) }), replay: "safe",
    execute: async (args) => {
      event("read_source", { file: String(args.file).trim() });
      const abs = resolveReadable(ws, args.file);
      if (!abs) return text(`No such readable file: ${args.file}. Pass a path list_sources shows.`, true);
      const body = readFileSync(abs, "utf8");
      return text(body.length > FILE_READ_CAP ? `${body.slice(0, FILE_READ_CAP)}\n…[truncated]` : body);
    },
  });
  const stateTool = defineTool({
    name: spec.stateTool.name, description: spec.stateTool.description, parameters: obj({}), replay: "safe",
    execute: async () => {
      event(spec.stateTool.name);
      const obs = readObservation(ws);
      return obs ? text(JSON.stringify(obs, null, 1))
        : text(`No observation was recorded. In source mode (a real folder with no lab world) there is none. Read the source with list_sources and read_source, and call ${spec.leadsTool.name} for the source leads.`, true);
    },
  });
  const leadsTool = defineTool({
    name: spec.leadsTool.name, description: spec.leadsTool.description, parameters: obj({}), replay: "safe",
    execute: async () => {
      event(spec.leadsTool.name);
      const nothingToRead = !readObservation(ws) && sourceFiles(ws).length === 0;
      if (nothingToRead) return text("No observation was recorded for this run and there is no source to scan.", true);
      return text(describeLeads(leadsFor(ws, spec.analyze), spec.empty));
    },
  });
  const runPoc = defineTool({
    name: "run_poc",
    description: "Compile and run a Foundry proof-of-concept test. Pass the full Solidity source of a test file and the name of the test contract in it. Returns the real forge output.",
    parameters: obj({
      test_source: str({ description: "complete .sol source: imports forge-std/Test.sol, one or more test contracts" }),
      contract_name: str({ description: "name of the test contract to run" }),
    }), replay: "unsafe",
    execute: async (args) => {
      const attempt = ++state.poc;
      if (attempt > MAX_POC) {
        event("run_poc-capped", { contract: args.contract_name, attempts: attempt });
        return text(`PoC attempt budget exhausted (${MAX_POC} runs used). Stop running tests. Submit any passing test that proves a real change, then write a short summary.`, true);
      }
      const artifact = `poc-${args.contract_name}-${attempt}`;
      event("artifact-open", { id: artifact, fileId: `poc-${args.contract_name}`, title: `${args.contract_name}.t.sol`, kind: "poc", lang: "solidity", attempt, contract: args.contract_name });
      event("artifact-delta", { id: artifact, text: args.test_source });
      event("artifact-done", { id: artifact });
      event("run_poc", { contract: args.contract_name, attempt });
      writePoc(ws, args.test_source);
      const result = await forgeTest(ws, { matchContract: args.contract_name });
      event("run_poc-done", { contract: args.contract_name, passed: result.passed, failed: result.failed, timedOut: result.timedOut });
      if (result.passed) state.passed.set(args.contract_name, args.test_source);
      const left = MAX_POC - attempt;
      const note = result.passed && !state.found.some((f) => f.poc === args.contract_name)
        ? `\n\nThis test PASSED. If it shows real harm (funds leave a deployed contract), call submit_finding for \`${args.contract_name}\`.` : "";
      return text(`${result.output || "(no output)"}${note}\n\n(${left} run_poc attempt${left === 1 ? "" : "s"} left.)`);
    },
  });
  const submitFinding = defineTool({
    name: "submit_finding",
    description: "Record one proven problem: one root cause, meaning one fix. Call it as soon as its test passes. It returns at once.",
    parameters: obj({
      title: str(), severity: str({ description: "critical | high | medium | low" }),
      poc_contract: str({ description: "name of your passing test contract" }),
      explanation: str({ description: "Plain-language write-up a non-expert can follow: short sentences, one idea each, identifiers in `backticks`, code in fenced blocks that name the language, and a final line starting with \"Fix:\"." }),
    }), replay: "safe",
    execute: async (args) => {
      const poc = String(args.poc_contract ?? "").trim();
      const source = state.passed.get(poc);
      if (!source) {
        event("submit-rejected", { poc, reason: "not-passed" });
        return text(`Cannot record this finding: your test \`${poc}\` has not passed run_poc in this session. Make that exact test pass and show the harm, then call submit_finding again.`, true);
      }
      const dup = state.found.find((f) => f.poc === poc);
      if (dup) {
        event("submit-rejected", { poc, reason: "duplicate" });
        return text(`\`${poc}\` is already recorded as finding #${dup.n}. Each finding needs its own test contract.`, true);
      }
      const n = state.found.length + 1;
      state.found.push({ n, title: args.title, severity: args.severity, poc, explanation: args.explanation, source });
      event("finding-submitted", { n, title: args.title, severity: args.severity, poc });
      const left = Math.max(0, MAX_POC - state.poc);
      return text(`Recorded finding #${n}: ${args.title} (${args.severity}). Do NOT stop. Continue with the next lead, worst first. Skip anything this finding's fix would also stop. You have ${left} run_poc attempt${left === 1 ? "" : "s"} left.`);
    },
  });
  return [listSources, readSource, stateTool, leadsTool, runPoc, submitFinding];
}

// One nudge when the model stops early with budget left.
export function chainNudge(state, noun) {
  if (state.found.length === 0 || state.poc >= MAX_POC) return null;
  const list = state.found.map((f) => `#${f.n} ${f.title} (${f.severity}, test \`${f.poc}\`)`).join("\n");
  const left = MAX_POC - state.poc;
  event("audit-continue", { found: state.found.length, left });
  return `You have recorded ${state.found.length} finding${state.found.length === 1 ? "" : "s"}:\n${list}\n\nGo back to the ${noun} list. Try each lead you have not proven or ruled out, worst first. You have ${left} run_poc attempt${left === 1 ? "" : "s"} left. Submit only a NEW root cause that the fixes above would not stop. If no leads are left, write the coverage summary now: one line per lead, marked "proven", "not exploitable", or "not tried".`;
}

// The prepass for one chain pack. Runs the lab world, turns the observation into
// leads, and returns them as the kickoff brief.
// Prompt for source mode: a real folder, no lab world. It names no Safe, no lab key and no
// lab helper, because a real repo has none of them.
const SOURCE_FOCUS = {
  "keys": "Look hardest at signatures (ecrecover, nonces, chain ids), who may change owners, signers, thresholds or modules, hard-coded keys, and any wallet or Safe logic.",
  "chain-watch": "Look hardest at proxies and upgrades (who may change the implementation or admin), owner and role changes, initializers, and silent state changes that emit no event.",
};
export const sourceSystem = (mode) => `You are an authorized offensive-security agent in an isolated sandbox.
The target is the Solidity code of a real project that the operator owns. It is under src/.
Your job: find every weakness that lets someone take funds or take control, and PROVE each
one with a runnable Foundry test. ${SOURCE_FOCUS[mode] ?? ""}

Rules of the environment:
- The sandbox has no network. forge-std is vendored. Solidity is 0.8.38.
- list_sources and read_source show the project code. Read the contracts you test.
- There is no lab and no recorded chain state. The state tool will say so. Do not wait for it.
- The leads tool returns ranked leads from our source checks. Aderyn leads come in the brief.
  A lead is a guess from the code text. It counts only when your test proves it.
- There are no known keys. Never invent a key. Use vm.addr(n), vm.prank and vm.deal.
- Write a test (a contract that imports forge-std/Test.sol and the project contract, for
  example \`import "../src/Vault.sol";\`) and run it with run_poc. Build the weak setup in
  setUp. Pick the exact path a real attacker has.
- A proof passes AND shows harm. Harm is one of two things.
  Funds: a contract you deployed loses ETH and another address gains it. Fund the victim
  with vm.deal AFTER you create it. Never fund it with a payable constructor, a call with
  value, or a transfer from an account: that ETH comes back out and nets to zero.
  Control: the replay changes the EIP-1967 implementation or admin slot, or the owner,
  threshold, module, guard or fallback handler of a Safe. A plain owner variable (slot 0) is
  NOT counted here, because this mode has no lab to say which contract it belongs to.
  Make the change as an OUTSIDER. A change made by the address that already holds the owner
  or admin role is a legitimate change and does not count. Do not use vm.store (not counted).
  A test that only reads state and changes nothing fails.
- When a proof passes, call submit_finding with a title, severity, the name of the passing
  test contract, and a short explanation.

How the audit works:
- One finding per ROOT CAUSE. One fix closes one finding. If fixing A also stops B, then B
  is part of A's impact. Do not write a second test for it.
- Plan first. List each suspect, worst first, in your reply. Include suspects the leads did
  not flag.
- Spend at most 3 run_poc attempts on one suspect. If it still fails, mark it "not proven"
  and move on.
- Use a NEW test contract name for each suspect.
- The moment a test passes, call submit_finding. Then CONTINUE with the next suspect.
- Not findings: a risk with no path to move funds or change control.
- Stop when every suspect is proven or ruled out, or the budget is spent. Then write a short
  coverage summary: one line per suspect, marked "proven", "not exploitable", or "not tried".

Severity:
- critical: anyone can drain funds now.
- high: an outsider takes control (owner, admin, implementation, signer) or drains with a
  leaked key.
- medium: a risky setup that needs another step.
- low: a note with no direct loss of funds.

Write each explanation so a smart 15-year-old with no security background can follow it. Use
Simplified Technical English: short sentences, one idea per sentence, plain words. Put
identifiers in \`backticks\` and every multi-line code snippet in a fenced block whose opening
fence names the language. End with a line that starts with "Fix:". Keep going without asking
the operator questions. Work from the actual code.`;

// The kickoff for source mode. `brief` is the prepass lead list (may be empty).
export function sourceKickoff(mode, brief) {
  const base = "Audit the contracts under src/. Call the leads tool, read the code, list every suspect worst first, then prove each one you can with its own passing Foundry test that deploys the real contract and moves ETH out or changes who controls it. Submit each proven finding as soon as its test passes. End with the coverage summary.";
  return brief
    ? `${base}\n\n${brief}\n\nA lead is real only once your test proves it. Leads from source checks and Aderyn are guesses from the code text. Drop one fast if it cannot move ETH or change control. Do not reason at length: write your first test as soon as you know the setup.`
    : base;
}

// Tell the agent when Aderyn did not run, so "no Aderyn leads" is never read as "clean".
export const aderynNote = (aderyn) => aderyn.available ? "" : `\n\nNOTE: Aderyn did NOT run (${String(aderyn.reason ?? "its image is missing").slice(0, 160)}). Having no Aderyn leads here does NOT mean the code is clean. Read the code yourself.`;

export async function chainPrepass(ws, { emit }, { mode, analyze }) {
  // Lab mode runs the world in Docker. Source mode (a real folder) skips it.
  const world = hasWorld(ws, mode);
  const obs = world ? await observe(ws, mode) : null;
  const aderyn = await aderynLeads(ws);
  const base = leadsFor(ws, analyze);
  // Aderyn leads come last in each impact class. They are a second engine on the source.
  const leads = mergeChain([...base.flatMap((l) => (l.engines ?? [l.engine]).map((engine) => ({ ...l, engine }))), ...aderyn.leads]);
  const block = obs ? (obs.block ?? obs.toBlock) : null;
  emit({ t: Date.now(), ev: "chain-scan", pack: mode, engines: [...new Set(leads.flatMap((l) => l.engines))],
    block, suspects: leads.length, source: !world, aderyn: aderyn.available,
    top: leads.slice(0, 8).map((l) => ({ check: l.check, impact: l.impact, where: l.where, block: l.block ?? null, engines: l.engines, corroborated: l.corroborated })) });
  return {
    env: { CHAIN_BRIEF: describeLeads(leads.slice(0, 12), "") + aderynNote(aderyn) },
    record: { mode, block, suspects: leads.length, source: !world, aderyn: aderyn.available,
      corroborated: leads.filter((l) => l.corroborated).length, top: leads.slice(0, 8).map((l) => ({ check: l.check, impact: l.impact, where: l.where })) },
  };
}
