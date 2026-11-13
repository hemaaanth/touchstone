// The blind-signing check for the Keys pack: is the hash a Safe owner approved the hash
// of a transaction the signers were shown?
//
//   1. The queue lab world (runtime/safe-queue.mjs) runs in the chain-tools image. It writes
//      `safe-queue.json` (read, then deleted): the queue the wallet UI showed, plus what the chain recorded
//      (ApproveHash events, ExecutionSuccess hashes, decoded execTransaction calls).
//   2. safe-hash-rs (Cyfrin) hashes each transaction offline, in Docker with no network,
//      as EIP-712 SafeTx typed data. We never compute a Safe hash ourselves.
//   3. Calibration first: the tool's hash of each executed transaction must equal the hash
//      the Safe itself emitted. If not, the check is unavailable and raises no lead.
//   4. An approved hash that no shown transaction hashes to is a lead: the owner signed
//      something they did not see. A lead is never a finding.
//
// Fail closed: a missing image, a tool error, a timeout or output we cannot parse makes the
// whole check unavailable, never clean.
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTool } from "../../lib/wrap.mjs";
import { IMAGE as CHAIN_IMAGE } from "./common.mjs";

export const SAFE_HASH_IMAGE = process.env.SAFE_HASH_IMAGE || "touchstone/safe-hash:0.0.19";
export const QUEUE = "safe-queue.json";
const ENGINE = "safe-hash-rs";
const HERE = dirname(fileURLToPath(import.meta.url));
const WORLD_SRC = join(HERE, "runtime", "safe-queue.mjs");
const WORLD_IN_WS = ".safe-queue-world.mjs";
const BUILD = "docker build -f spike/packs/keys/safe-hash/Dockerfile -t touchstone/safe-hash:0.0.19 spike/packs/keys/safe-hash";
const NO_IMAGE = /unable to find image|no such image|pull access denied/i;
const HEX32 = /^0x[0-9a-f]{64}$/;
const lc = (s) => String(s ?? "").toLowerCase();
const short = (s) => `${String(s).slice(0, 6)}…${String(s).slice(-4)}`;

// ---------------------------------------------------------------- the queue lab world

// Run the queue world once. Returns { ok, queue } or { ok: false, reason }.
// The queue file is read and then deleted, so the agent's workspace never holds this second
// chain: its only chain is the target in chain-observation.json.
export async function runQueueWorld(ws, { timeoutMs = 180_000, image = CHAIN_IMAGE } = {}) {
  const file = join(ws, QUEUE);
  rmSync(file, { force: true });
  copyFileSync(WORLD_SRC, join(ws, WORLD_IN_WS));
  let run;
  try {
    run = await runTool({ image, ws, env: { HOME: "/tmp" }, timeoutMs, cmd: ["node", WORLD_IN_WS] });
  } finally { rmSync(join(ws, WORLD_IN_WS), { force: true }); }
  try {
    if (!existsSync(file) || run.code !== 0) {
      const why = run.timedOut ? "timed out" : NO_IMAGE.test(run.stderr) ? `image ${image} not built` : `exit ${run.code}: ${run.stderr.slice(-200)}`;
      return { ok: false, reason: `the Safe queue lab did not run (${why})` };
    }
    try { return { ok: true, queue: JSON.parse(readFileSync(file, "utf8")) }; }
    catch { return { ok: false, reason: "the Safe queue lab wrote a file that is not JSON" }; }
  } finally { rmSync(file, { force: true }); }
}

// ---------------------------------------------------------------- the tool

const SAFE_TX = [["to", "address"], ["value", "uint256"], ["data", "bytes"], ["operation", "uint8"],
  ["safeTxGas", "uint256"], ["baseGas", "uint256"], ["gasPrice", "uint256"], ["gasToken", "address"],
  ["refundReceiver", "address"], ["nonce", "uint256"]];

// EIP-712 typed data for one Safe 1.3+ transaction. Safe 1.3+ domain: chainId and verifyingContract.
export function safeTxTypedData(chainId, safe, fields, nonce) {
  const message = Object.fromEntries(SAFE_TX.map(([name, type]) => {
    const value = name === "nonce" ? nonce : fields[name];
    return [name, type === "address" || type === "bytes" ? String(value) : type === "uint8" ? Number(value) : String(value)];
  }));
  return {
    types: { EIP712Domain: [{ name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
      SafeTx: SAFE_TX.map(([name, type]) => ({ name, type })) },
    primaryType: "SafeTx", domain: { chainId: Number(chainId), verifyingContract: String(safe) }, message,
  };
}

// Parse the output of `safe-hash typed --standalone`. All three hashes or null.
export function parseSafeHash(text) {
  const pick = (label) => lc(String(text ?? "").match(new RegExp(`^${label}:\\s+(0x[0-9a-fA-F]{64})\\s*$`, "m"))?.[1]);
  const out = { safeTxHash: pick("EIP 712 Hash"), domainHash: pick("Domain Hash"), messageHash: pick("Message Hash") };
  return Object.values(out).every((h) => HEX32.test(h)) ? out : null;
}

// One container hashes the whole batch. Each job goes in as an env var, so the tool sees
// no workspace. Returns { ok, hashes: Map(id -> parsed) } or { ok: false, reason }.
const BATCH = 'i=0; while [ "$i" -lt "$N" ]; do printenv "J$i" > /tmp/$i.json; echo "@@ job $i"; '
  + 'safe-hash typed --standalone --file /tmp/$i.json 2>&1; echo "@@ exit $?"; i=$((i+1)); done';
export async function hashWithSafeHash(jobs, { timeoutMs = 60_000, image = SAFE_HASH_IMAGE } = {}) {
  if (!jobs.length) return { ok: true, hashes: new Map() };
  const env = { N: String(jobs.length) };
  jobs.forEach((job, i) => { env[`J${i}`] = JSON.stringify(job.typed); });
  const run = await runTool({ image, cmd: ["sh", "-c", BATCH], ws: null, env, timeoutMs });
  // Stopping the container at the limit is runTool's job (the shared wrap fix), not ours.
  if (run.timedOut) return { ok: false, reason: `${ENGINE} timed out` };
  if (NO_IMAGE.test(run.stderr)) return { ok: false, reason: `image ${image} not built (${BUILD})` };
  const sections = run.stdout.split(/^@@ job (\d+)$/m).slice(1);
  const hashes = new Map();
  for (let k = 0; k < sections.length; k += 2) {
    const job = jobs[Number(sections[k])];
    const body = sections[k + 1] ?? "";
    if (!job || hashes.has(job.id)) return { ok: false, reason: `${ENGINE} printed job ${sections[k]}, which is not one of the ${jobs.length} jobs or came twice` };
    const exit = body.match(/^@@ exit (\d+)$/m)?.[1];
    const parsed = parseSafeHash(body);
    if (exit !== "0" || !parsed) return { ok: false, reason: `${ENGINE} failed on ${job.id}: ${body.replace(/^@@ exit.*$/m, "").trim().slice(0, 160) || "no output"}` };
    hashes.set(job.id, parsed);
  }
  if (run.code !== 0 || hashes.size !== jobs.length) return { ok: false, reason: `${ENGINE} hashed ${hashes.size} of ${jobs.length} transactions (exit ${run.code}${run.stderr ? `: ${run.stderr.slice(-160)}` : ""})` };
  return { ok: true, hashes };
}

// ---------------------------------------------------------------- the check

// Every transaction to hash: each executed call (for calibration) and each shown entry.
export function queueJobs(queue) {
  const jobs = [];
  for (const safe of queue?.safes ?? []) {
    for (const ex of safe.executions ?? []) if (ex.fields)
      jobs.push({ id: `${lc(safe.address)}:executed:${ex.nonce}`, typed: safeTxTypedData(queue.chainId, safe.address, ex.fields, ex.nonce) });
    for (const entry of safe.queue ?? [])
      jobs.push({ id: `${lc(safe.address)}:shown:${entry.nonce}`, typed: safeTxTypedData(queue.chainId, safe.address, entry.shown, entry.nonce) });
  }
  return jobs;
}

// Compare the tool's hashes with the chain. Pure: no Docker. Returns
// { available, reason?, leads, checked, gaps }.
export function compareQueue(queue, hashes, engine = ENGINE) {
  const leads = [];
  const checked = [];
  const gaps = [];
  for (const safe of queue?.safes ?? []) {
    const addr = lc(safe.address);
    // The queue lab is its own chain, not the target. `where` says so, so no lead reads as a target address.
    const where = `chain ${queue.chainId} ${addr}`;
    const label = `Safe "${safe.name}" ${short(safe.address)}`;
    const execs = (safe.executions ?? []).filter((ex) => ex.fields);
    if (!execs.length) { gaps.push(`${label}: no executed transaction to calibrate ${engine} against, so it was not checked`); continue; }
    for (const ex of execs) {
      const got = hashes.get(`${addr}:executed:${ex.nonce}`)?.safeTxHash;
      if (got !== lc(ex.hash)) {
        return { available: false, reason: `calibration failed: ${engine} hashed executed nonce ${ex.nonce} of ${label} to ${got ?? "nothing"}, the Safe emitted ${lc(ex.hash)}`, leads: [], checked, gaps };
      }
    }
    const shown = new Map((safe.queue ?? []).map((e) => [e.nonce, hashes.get(`${addr}:shown:${e.nonce}`)?.safeTxHash]));
    if ([...shown.values()].some((h) => !h)) return { available: false, reason: `${engine} returned no hash for a shown transaction of ${label}`, leads: [], checked, gaps };
    // Bound to this Safe: every hash must use the domain (chain + Safe) of the calibrated executions.
    const domains = new Set([...execs.map((ex) => `executed:${ex.nonce}`), ...(safe.queue ?? []).map((e) => `shown:${e.nonce}`)]
      .map((k) => hashes.get(`${addr}:${k}`)?.domainHash));
    if (domains.size !== 1) return { available: false, reason: `${engine} used more than one domain for ${label}, so its hashes are not all for this Safe`, leads: [], checked, gaps };
    checked.push({ safe: addr, chainId: queue.chainId, calibrated: execs.length, shown: Object.fromEntries(shown) });
    const shownList = [...shown].map(([n, h]) => `nonce ${n} → ${short(h)}`).join(", ");
    for (const ex of execs) {
      const want = shown.get(ex.nonce);
      if (want && want !== lc(ex.hash)) {
        leads.push({ engine, check: "safe-hash-mismatch", impact: "High", where, block: ex.block,
          description: `${label} (Safe queue lab, chain ${queue.chainId}) executed nonce ${ex.nonce} with hash ${lc(ex.hash)}. The signers were shown a transaction for that nonce that ${engine} hashes to ${want}. What ran is not what they saw.` });
      }
    }
    const known = new Set([...shown.values(), ...execs.map((ex) => lc(ex.hash))]);
    for (const ap of safe.approvals ?? []) {
      if (known.has(lc(ap.hash))) continue;
      leads.push({ engine, check: "safe-hash-mismatch", impact: "High", where, block: ap.block, owner: lc(ap.owner), hash: lc(ap.hash),
        description: `${label} (Safe queue lab, chain ${queue.chainId}): owner ${ap.owner} approved hash ${lc(ap.hash)} on chain (approveHash, block ${ap.block}). No transaction the signers were shown hashes to it. ${engine} hashed each shown transaction offline: ${shownList}. The owner signed a transaction they did not see (blind signing). Only the hash is on chain, so the real fields stay unknown until someone executes it.` });
    }
  }
  if (!checked.length) return { available: false, reason: gaps[0] ?? "the Safe queue has no Safe to check", leads: [], checked, gaps };
  return { available: true, leads, checked, gaps };
}

// The note for the agent's brief, per engine. It says when the check did not run.
export function safeHashNote(result, engine = ENGINE) {
  if (!result.available) return `\n\nNOTE: ${engine} did NOT check the Safe queue (${String(result.reason).slice(0, 200)}). Having no lead from ${engine} does NOT mean the signers saw what they approved.`;
  const gaps = result.gaps.length ? ` Not checked: ${result.gaps.join("; ")}.` : "";
  return `\n\n${engine} hashed the Safe queue offline for ${result.checked.length} Safe(s); its hash of every executed transaction matched the hash the Safe emitted.${gaps}`;
}

// An engine hashes the queue: { name, flag, hash(queue) -> { ok, hashes, extraLeads? } | { ok: false, reason } }.
export const SAFE_HASH_ENGINE = { name: ENGINE, flag: "safeHash", hash: (queue, opts) => hashWithSafeHash(queueJobs(queue), opts) };

// The prepass hook. Lab mode only: a real folder has no Safe queue and no chain.
// It runs the queue world once, then each engine. Each engine is calibrated and reported
// on its own; its extra leads count only when it passed calibration. Never throws.
// opts.worldImage and opts.images[engine name] replace the images (tests use this).
export async function safeHashLeads(ws, { world }, { engines = [SAFE_HASH_ENGINE], worldImage, images = {} } = {}) {
  const off = (reason) => ({ available: false, reason, leads: [], checked: [], gaps: [] });
  const one = async (engine, queue) => {
    try {
      const hashed = await engine.hash(queue, images[engine.name] ? { image: images[engine.name] } : {});
      if (!hashed.ok) return off(hashed.reason);
      const result = compareQueue(queue, hashed.hashes, engine.name);
      return result.available ? { ...result, leads: [...result.leads, ...(hashed.extraLeads ?? [])] } : result;
    } catch (error) { return off(String(error?.message ?? error).slice(0, 200)); }
  };
  let results;
  if (!world) results = engines.map(() => off("source mode: there is no Safe queue to check"));
  else {
    let lab;
    try { lab = await runQueueWorld(ws, worldImage ? { image: worldImage } : {}); }
    catch (error) { lab = { ok: false, reason: String(error?.message ?? error).slice(0, 200) }; }
    results = lab.ok ? await Promise.all(engines.map((e) => one(e, lab.queue))) : engines.map(() => off(lab.reason));
  }
  return {
    tool: engines.map((e) => e.name).join(" + "),
    flags: Object.fromEntries(engines.map((e, i) => [e.flag, results[i].available])),
    available: results.some((r) => r.available),
    reason: results.map((r, i) => (r.available ? "" : `${engines[i].name}: ${r.reason}`)).filter(Boolean).join("; ") || undefined,
    leads: results.flatMap((r) => r.leads),
    results: Object.fromEntries(engines.map((e, i) => [e.name, results[i]])),
    note: results.map((r, i) => safeHashNote(r, engines[i].name)).join(""),
  };
}
