import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Hex keys use lowercase hex without 0x, so scanners share one fingerprint.
export function redactSecret(value) {
  const text = String(value);
  const material = /^(?:0x)?[a-f0-9]{64}$/i.test(text) ? text.replace(/^0x/i, "").toLowerCase() : text;
  return { redacted: "[REDACTED]", sha256: sha256(material) };
}

function inside(ws, file) {
  if (typeof file !== "string" || !file || isAbsolute(file)) throw new Error("Invalid evidence path");
  const root = realpathSync(ws);
  const abs = realpathSync(resolve(root, file));
  const rel = relative(root, abs);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Evidence path escapes workspace");
  return abs;
}

function config(ws) {
  return JSON.parse(readFileSync(resolve(ws, ".touchstone.json"), "utf8"));
}

// The operator pins once, before the model starts. A later call cannot re-pin.
export function pinSnapshot(ws, snapshot, { file = "snapshot.json" } = {}) {
  let cfg;
  try { cfg = config(ws); } catch (err) { if (err.code !== "ENOENT") throw err; cfg = {}; }
  if (cfg.evidenceSnapshot || cfg.snapshotHash) {
    const pinned = loadSnapshot(ws);
    if (sha256(JSON.stringify(pinned.snapshot)) !== sha256(JSON.stringify(snapshot))) throw new Error("Snapshot already pinned");
    return pinned.snapshotHash;
  }
  if (file !== "snapshot.json") throw new Error("Pin snapshots at snapshot.json");
  const bytes = JSON.stringify(snapshot);
  const hash = sha256(bytes);
  writeFileSync(resolve(ws, file), bytes, { flag: "wx", mode: 0o600 });
  writeFileSync(resolve(ws, ".touchstone.json"), JSON.stringify({ ...cfg, evidenceSnapshot: { file, sha256: hash } }, null, 2));
  return hash;
}

export function loadSnapshot(ws, { snapshotFile, snapshotHash } = {}) {
  const cfg = config(ws);
  const file = snapshotFile ?? cfg.evidenceSnapshot?.file ?? "snapshot.json";
  const expected = snapshotHash ?? cfg.evidenceSnapshot?.sha256 ?? cfg.snapshotHash;
  if (!/^[a-f0-9]{64}$/.test(expected ?? "")) throw new Error("Missing snapshot SHA-256 pin");
  const bytes = readFileSync(inside(ws, file));
  if (bytes.length > 16 * 1024 * 1024) throw new Error("Snapshot exceeds 16 MiB");
  if (sha256(bytes) !== expected) throw new Error("Snapshot bytes changed");
  return { snapshot: JSON.parse(bytes), snapshotHash: expected };
}

// A detector must return { ok: true } only for the exact location it supports.
// DNS and HTTP packs use captured records in snapshot.json, never live requests.
async function confirmEvidence({ snapshot, snapshotHash }, evidence, detectors) {
  if (!evidence || evidence.snapshotHash !== snapshotHash) throw new Error("Evidence pin does not match");
  if (!Object.hasOwn(detectors, evidence.check) || typeof detectors[evidence.check] !== "function") throw new Error("Unsupported evidence check");
  const result = await detectors[evidence.check](snapshot, evidence.where);
  if (result?.ok !== true) throw new Error("Detector did not confirm the claim");
  // Ignore detector prose: it may contain an unredacted source value.
  return { kind: "evidence", status: "pass", check: evidence.check, snapshotHash,
    ...(snapshot.commit ? { commit: snapshot.commit } : {}), detail: "Allowlisted detector confirmed the pinned evidence." };
}

const failed = () => ({ kind: "evidence", status: "fail", detail: "Evidence is missing, changed, unsupported, or not confirmed." });

export async function replayEvidence(ws, evidence, { detectors = {}, ...options } = {}) {
  try { return await confirmEvidence(loadSnapshot(ws, options), evidence, detectors); }
  catch { return failed(); }
}

export async function proveFindings(ws, found, events, log = () => {}, { detectors = {}, ...options } = {}) {
  const out = [];
  let pinned;
  try { pinned = loadSnapshot(ws, options); } catch { log("Evidence replay: fail"); return out; }
  for (const finding of found) {
    let proof;
    try { proof = await confirmEvidence(pinned, finding.evidence, detectors); } catch { proof = failed(); }
    log(`Evidence replay: ${proof.status}`);
    if (proof.status === "pass") out.push({ ...finding, proof, proven: true });
  }
  const rank = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 };
  return out.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
}
