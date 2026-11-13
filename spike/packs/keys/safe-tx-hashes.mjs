// safe-tx-hashes-util (pcaversaccio, AGPL-3.0) as the second engine of the Keys blind-signing
// check (safe-hash.mjs). It runs the upstream `safe_hashes.sh`, unchanged, in Docker with no
// network. Its calls to the Safe Transaction Service fail, so it runs in its `--interactive`
// mode: the pack answers its prompts on stdin with the fields of each queued transaction.
//
// It gives two things:
//   1. Its own Safe transaction hash. The pack compares it with the chain, as for safe-hash-rs.
//      It builds the domain from the Safe version, so it also covers Safes below 1.3.
//   2. Its warnings on the fields: an untrusted delegatecall, and a custom gas token or refund
//      receiver (a hidden payout through gas refunds). Each is a lead. A lead is never a finding.
//
// Fail closed: a missing image, a timeout, a non-zero exit (of the container or of one job),
// an unknown or repeated job section, an empty hash (the script prints
// empty hashes with exit 0 when chisel has no solc), or an echo that does not match our input
// makes the whole engine unavailable, never clean.
import { runTool } from "../../lib/wrap.mjs";
import { underTimeout } from "./safe-hash.mjs";

export const SAFE_TX_HASHES_IMAGE = process.env.SAFE_TX_HASHES_IMAGE || "touchstone/safe-tx-hashes:e295975";
const ENGINE = "safe-tx-hashes-util";
const BUILD = "docker build -f spike/packs/keys/safe-tx-hashes/Dockerfile -t touchstone/safe-tx-hashes:e295975 spike/packs/keys/safe-tx-hashes";
const NO_IMAGE = /unable to find image|no such image|pull access denied/i;
const HEX32 = /^0x[0-9a-f]{64}$/;
const lc = (s) => String(s ?? "").toLowerCase();

// Chain ID -> the script's network name (its own table). Another chain is not checked.
export const NETWORKS = { 1: "ethereum", 10: "optimism", 100: "gnosis", 137: "polygon", 8453: "base", 42161: "arbitrum", 11155111: "sepolia" };
const ANSWERS = ["to", "value", "data", "operation", "safeTxGas", "baseGas", "gasPrice", "gasToken", "refundReceiver"];

// One job per transaction: the same ids as safe-hash.mjs queueJobs, plus the Safe version.
export function txHashesJobs(queue) {
  const jobs = [];
  for (const safe of queue?.safes ?? []) {
    const base = { chainId: queue.chainId, safe: safe.address, version: safe.version };
    for (const ex of safe.executions ?? []) if (ex.fields)
      jobs.push({ ...base, id: `${lc(safe.address)}:executed:${ex.nonce}`, kind: "executed", nonce: ex.nonce, fields: ex.fields });
    for (const entry of safe.queue ?? [])
      jobs.push({ ...base, id: `${lc(safe.address)}:shown:${entry.nonce}`, kind: "shown", nonce: entry.nonce, fields: entry.shown });
  }
  return jobs;
}

// The argv line for one job: network, Safe, nonce, version, then the nine answers. An empty
// answer would make the script use its default (zero), so a job with one is refused.
export function jobLine(job) {
  const network = NETWORKS[Number(job.chainId)];
  if (!network) return { error: `chain ${job.chainId} is not in the ${ENGINE} network list` };
  const parts = [network, job.safe, String(job.nonce), job.version, ...ANSWERS.map((k) => String(job.fields?.[k] ?? ""))];
  if (parts.some((p) => !/^[0-9A-Za-z.+]+$/.test(p))) return { error: `${job.id} has an empty or malformed field` };
  return { line: parts.join(" ") };
}

// Parse one run of `safe_hashes.sh`. Returns { safeTxHash, domainHash, messageHash, warnings }
// or null. The echoed Safe, fields and nonce must equal the job, so a shifted prompt fails.
export function parseSafeTxHashes(text, job) {
  const field = (label) => String(text ?? "").match(new RegExp(`^${label}: *(.*?) *$`, "m"))?.[1] ?? null;
  const out = { safeTxHash: lc(field("Safe transaction hash")), domainHash: lc(field("Domain hash")), messageHash: lc(field("Message hash")) };
  if (!Object.values(out).every((h) => HEX32.test(h))) return null;
  if (job) {
    const f = job.fields ?? {};
    const echo = { "Multisig address": job.safe, To: f.to, Value: f.value, Data: f.data, Nonce: job.nonce,
      "Safe Transaction Gas": f.safeTxGas, "Base Gas": f.baseGas, "Gas Price": f.gasPrice, "Gas Token": f.gasToken, "Refund Receiver": f.refundReceiver };
    if (Object.entries(echo).some(([label, want]) => lc(field(label)) !== lc(want))) return null;
    if (!(field("Operation") ?? "").startsWith(Number(f.operation) === 1 ? "Delegatecall" : "Call")) return null;
  }
  const t = String(text);
  const warnings = [];
  if (/WARNING: The transaction includes an untrusted delegate call/.test(t)) warnings.push("untrusted-delegatecall");
  if (/WARNING: This transaction uses a custom gas token and a custom refund receiver/.test(t)) warnings.push("gas-token-and-refund-receiver");
  else if (/WARNING: This transaction uses a custom gas token\./.test(t)) warnings.push("custom-gas-token");
  else if (/WARNING: This transaction uses a custom refund receiver\./.test(t)) warnings.push("custom-refund-receiver");
  return { ...out, warnings };
}

// One container runs every job at once (each run takes about 14 s, most of it chisel).
// The script wants EIP-55 addresses, so `cast` from the same image checksums them first.
// No `${...}` in this text: String.raw would still fill it in from JS.
const BATCH = String.raw`
ck() { cast to-check-sum-address "$1"; }
run() {
  set -- $1
  net=$1; safe=$2; nonce=$3; ver=$4; shift 4
  printf '%s\n' "$ver" "$(ck "$1")" "$2" "$3" "$4" "$5" "$6" "$7" "$(ck "$8")" "$(ck "$9")" \
    | safe_hashes.sh --network "$net" --address "$(ck "$safe")" --nonce "$nonce" --interactive
}
i=0; while [ "$i" -lt "$N" ]; do ( run "$(printenv "J$i")" > /tmp/$i.out 2>&1; echo "@@ exit $?" >> /tmp/$i.out ) & i=$((i+1)); done
wait
i=0; while [ "$i" -lt "$N" ]; do echo "@@ job $i"; cat /tmp/$i.out; i=$((i+1)); done`;

export async function hashWithSafeTxHashes(jobs, { timeoutMs = 180_000, image = SAFE_TX_HASHES_IMAGE } = {}) {
  if (!jobs.length) return { ok: true, hashes: new Map() };
  const env = { N: String(jobs.length), HOME: "/tmp" };
  for (const [i, job] of jobs.entries()) {
    const { line, error } = jobLine(job);
    if (error) return { ok: false, reason: error };
    env[`J${i}`] = line;
  }
  // GNU timeout as PID 1 stops a hung container at the limit (see underTimeout in safe-hash.mjs).
  const run = await runTool({ image, cmd: underTimeout(timeoutMs, ["bash", "-c", BATCH]), ws: null, env, timeoutMs });
  if (run.timedOut || run.code === 124) return { ok: false, reason: `${ENGINE} timed out` };
  if (NO_IMAGE.test(run.stderr)) return { ok: false, reason: `image ${image} not built (${BUILD})` };
  const sections = run.stdout.split(/^@@ job (\d+)$/m).slice(1);
  const hashes = new Map();
  for (let k = 0; k < sections.length; k += 2) {
    const job = jobs[Number(sections[k])];
    const body = sections[k + 1] ?? "";
    if (!job || hashes.has(job.id)) return { ok: false, reason: `${ENGINE} printed job ${sections[k]}, which is not one of the ${jobs.length} jobs or came twice` };
    const exit = body.match(/^@@ exit (\d+)$/m)?.[1];
    const parsed = parseSafeTxHashes(body, job);
    if (exit !== "0" || !parsed) {
      const tail = body.replace(/^@@ exit.*$/m, "").trim().split("\n").slice(-3).join(" ").slice(0, 200);
      return { ok: false, reason: `${ENGINE} failed on ${job.id} (exit ${exit ?? "?"}): ${tail || "no output"}` };
    }
    hashes.set(job.id, parsed);
  }
  if (run.code !== 0 || hashes.size !== jobs.length) return { ok: false, reason: `${ENGINE} hashed ${hashes.size} of ${jobs.length} transactions (exit ${run.code}${run.stderr ? `: ${run.stderr.slice(-160)}` : ""})` };
  return { ok: true, hashes };
}

// Leads from the script's own warnings. Pure: no Docker. Only run after calibration passed.
const WARN = {
  "untrusted-delegatecall": ["safe-tx-untrusted-delegatecall", "High", (to) => `is a delegatecall (operation 1) to ${to}, which ${ENGINE} does not trust (not a known MultiSendCallOnly, SafeMigration or SignMessageLib). A delegatecall runs that code with the Safe's own storage: it can change owners, modules or the guard, or move every asset`],
  "gas-token-and-refund-receiver": ["safe-tx-gas-refund", "Medium", () => `uses a custom gas token and a custom refund receiver. ${ENGINE} warns this can hide a payout through the gas refund`],
  "custom-gas-token": ["safe-tx-gas-refund", "Low", () => `uses a custom gas token`],
  "custom-refund-receiver": ["safe-tx-gas-refund", "Low", () => `uses a custom refund receiver`],
};
export function warningLeads(jobs, hashes) {
  const leads = [];
  for (const job of jobs) {
    for (const w of hashes.get(job.id)?.warnings ?? []) {
      const [check, impact, says] = WARN[w];
      const what = job.kind === "shown" ? `The queued transaction for nonce ${job.nonce} (shown to the signers, not executed)` : `Executed nonce ${job.nonce}`;
      leads.push({ engine: ENGINE, check, impact, where: `chain ${job.chainId} ${lc(job.safe)}`, block: null, nonce: job.nonce, hash: hashes.get(job.id).safeTxHash,
        description: `Safe ${job.safe} (Safe queue lab, chain ${job.chainId}): ${what} ${says(job.fields.to)}. Its Safe transaction hash is ${hashes.get(job.id).safeTxHash}. A signer who sees only that hash cannot tell.` });
    }
  }
  return leads;
}

// The engine for safe-hash.mjs safeHashLeads.
export const SAFE_TX_HASHES_ENGINE = {
  name: ENGINE,
  flag: "safeTxHashes",
  async hash(queue, opts) {
    const jobs = txHashesJobs(queue);
    const out = await hashWithSafeTxHashes(jobs, opts);
    return out.ok ? { ...out, extraLeads: warningLeads(jobs, out.hashes) } : out;
  },
};
