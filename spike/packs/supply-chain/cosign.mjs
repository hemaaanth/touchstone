// cosign: offline signature checks of release artifacts in the pinned snapshot.
//
// The operator gives a signing policy: one pinned public key (PEM) and the list
// of artifact paths that must be signed. The policy lives in .touchstone.json,
// not in the target repo, because a key that the repo itself ships proves nothing.
// For each artifact, cosign runs `verify-blob` with the bundle next to it and the
// pinned key. It runs through runTool(): --network none, --pull=never.
//
// No Rekor and no Fulcio. A key-signed bundle has no transparency log entry, so
// verify needs --insecure-ignore-tlog=true. Without that flag cosign tries to
// fetch the Sigstore TUF root and fails on the blocked network (an error, not a
// pass). Keyless bundles (certificate + log proof) are not handled here.
//
// Results:
//   Verified OK            no lead; counted in coverage
//   invalid signature      lead `cosign/invalid-signature` (tool:cosign evidence)
//   no bundle in snapshot  lead `artifact-signature-missing` (Touchstone check)
//   anything else          a coverage gap for that artifact, never a pass
import { createHash, createPublicKey } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { execFileSync } from "node:child_process";
import { runTool } from "../../lib/wrap.mjs";

export const COSIGN = { image: "touchstone-cosign:v3.1.4", dir: new URL("./cosign/", import.meta.url) };
export const MAX_ARTIFACTS = 20;
export const BUNDLE_SUFFIXES = [".sigstore.json", ".sigstore", ".bundle"];
const sha = (s) => createHash("sha256").update(s).digest("hex");
const safePath = (p) => typeof p === "string" && p.length > 0 && p.length < 512 && !posix.isAbsolute(p) && posix.normalize(p) === p && !p.split("/").includes("..") && /^[A-Za-z0-9_./@+-]+$/.test(p);

// Build the pinned image once. Build time may use the network; a run never does.
export function buildCosignImage(exec = execFileSync) {
  try { exec("docker", ["image", "inspect", COSIGN.image], { stdio: "ignore" }); return null; }
  catch {
    try { exec("docker", ["build", "-t", COSIGN.image, COSIGN.dir.pathname], { stdio: "ignore", timeout: 600_000 }); return null; }
    catch (e) { return `Could not build ${COSIGN.image}. ${String(e.message ?? e).slice(-200)}`; }
  }
}

// The policy is operator input. Anything malformed is an error, never "no policy".
export function parsePolicy(policy) {
  if (policy == null) return null;
  if (typeof policy !== "object" || typeof policy.publicKey !== "string" || !Array.isArray(policy.artifacts)) throw new Error("cosign policy needs publicKey (PEM) and artifacts (list)");
  let key;
  try { key = createPublicKey(policy.publicKey); } catch { throw new Error("cosign policy publicKey is not a PEM public key"); }
  if (!/^-----BEGIN PUBLIC KEY-----/.test(policy.publicKey.trim())) throw new Error("cosign policy publicKey must be a PEM PUBLIC KEY block");
  const publicKey = key.export({ type: "spki", format: "pem" });
  if (!policy.artifacts.length || policy.artifacts.length > MAX_ARTIFACTS) throw new Error(`cosign policy needs 1 to ${MAX_ARTIFACTS} artifacts`);
  const artifacts = policy.artifacts.map((a) => {
    const path = typeof a === "string" ? a : a?.path;
    const bundle = typeof a === "object" && a ? a.bundle : undefined;
    if (!safePath(path) || (bundle !== undefined && !safePath(bundle))) throw new Error("cosign policy has an invalid artifact path");
    return { path, bundles: bundle ? [bundle] : BUNDLE_SUFFIXES.map((s) => path + s) };
  });
  return { publicKey, keySha256: sha(key.export({ type: "spki", format: "der" })), artifacts };
}

// Map cosign's exit and stderr to one result word. Only two exact outcomes count;
// everything else is "error", which the caller turns into a gap.
export function classify(r, image = COSIGN.image) {
  if (r.timedOut) return { result: "error", reason: "cosign timed out", timedOut: true };
  if (r.code === 125 && /No such image|Unable to find image|pull access denied/i.test(r.stderr)) return { result: "unavailable", reason: `image ${image} is not built` };
  if (r.code === 0 && /^Verified OK$/m.test(r.stderr)) return { result: "verified" };
  if (r.code === 1 && /^Error: failed to verify signature: could not verify message: invalid signature/m.test(r.stderr)) return { result: "invalid-signature" };
  const line = (r.stderr.match(/^Error: (.*)$/m)?.[1] ?? `exit ${r.code}`).replace(/[^\x20-\x7e]/g, "").slice(0, 160);
  return { result: "error", reason: `cosign could not decide: ${line}` };
}

// One container per artifact. Only three files are staged: blob, bundle, key.
export async function verifyBlob({ artifact, bundle, publicKey }, { image = COSIGN.image, timeoutMs = 60_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "touchstone-cosign-"));
  try {
    writeFileSync(join(dir, "blob"), artifact, { mode: 0o600 });
    writeFileSync(join(dir, "bundle.json"), bundle, { mode: 0o600 });
    writeFileSync(join(dir, "key.pub"), publicKey, { mode: 0o600 });
    const r = await runTool({ image, ws: dir, timeoutMs, env: { HOME: "/tmp" },
      cmd: ["verify-blob", "--key", "/work/key.pub", "--bundle", "/work/bundle.json", "--insecure-ignore-tlog=true", "/work/blob"] });
    return classify(r, image);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const where = (rule, a, extra) => ({ file: a.path, line: 1, rule, artifactSha256: sha(a.text), ...extra });
function leadOf(engine, check, impact, a, w, description) {
  return { engine, check, impact, file: a.path, lines: [1], where: w, description };
}

// Returns the scanner shape pack.mjs uses, plus per-artifact gaps.
export async function cosignScan(snapshot, rawPolicy, opts = {}) {
  const engine = "cosign";
  const bundlesInRepo = Object.keys(snapshot.files).filter((f) => BUNDLE_SUFFIXES.some((s) => f.endsWith(s)));
  let policy;
  try { policy = parsePolicy(rawPolicy); }
  catch (e) { return { engine, status: "error", reason: e.message, leads: [], gaps: [{ kind: "signature-policy-invalid", detail: `${e.message}. No artifact signature was checked.` }] }; }
  if (!policy) {
    const gaps = bundlesInRepo.length ? [{ kind: "signatures-not-verified", detail: `${bundlesInRepo.length} signature bundles are in the snapshot, but no operator signing policy pins a key. They were not verified.`, sample: bundlesInRepo.slice(0, 10) }] : [];
    return { engine, status: "ok", reason: "no signing policy (pinned key and artifact list)", leads: [], gaps };
  }
  const skipped = new Set((snapshot.skipped ?? []).map((s) => s.file));
  const leads = [], gaps = [], tally = { verified: 0, invalid: 0, unsigned: 0, gap: 0 };
  let unavailable = null, timedOut = false;
  const gap = (a, detail) => { tally.gap++; gaps.push({ kind: "artifact-signature-unchecked", file: a.path, detail }); };
  for (const art of policy.artifacts) {
    if (!Object.hasOwn(snapshot.files, art.path)) { gap(art, skipped.has(art.path) ? "Artifact was skipped by the snapshot (binary, too large or over budget). Its signature was not checked." : "Artifact named in the signing policy is not in the snapshot."); continue; }
    const a = { ...art, text: snapshot.files[art.path] };
    const bundle = art.bundles.find((b) => Object.hasOwn(snapshot.files, b));
    if (!bundle) {
      if (art.bundles.some((b) => skipped.has(b))) { gap(a, "A signature bundle exists but the snapshot skipped it. Its signature was not checked."); continue; }
      tally.unsigned++;
      leads.push(leadOf("Touchstone", "artifact-signature-missing", "Medium", a, where("artifact-signature-missing", a, { bundles: art.bundles }),
        "The signing policy says this artifact must be signed, but no signature bundle is next to it in the pinned snapshot."));
      continue;
    }
    // Once the image is missing, no later artifact can be checked either.
    const r = unavailable ?? await verifyBlob({ artifact: a.text, bundle: snapshot.files[bundle], publicKey: policy.publicKey }, opts);
    if (r.result === "unavailable") { unavailable = r; gap(a, `${r.reason}. Build it: docker build -t ${COSIGN.image} spike/packs/supply-chain/cosign`); continue; }
    if (r.result === "verified") { tally.verified++; continue; }
    if (r.result === "invalid-signature") {
      tally.invalid++;
      leads.push(leadOf(engine, "cosign/invalid-signature", "High", a,
        where("cosign/invalid-signature", a, { bundle, bundleSha256: sha(snapshot.files[bundle]), keySha256: policy.keySha256, publicKey: policy.publicKey }),
        "cosign verify-blob rejected the signature with the pinned key. The artifact was changed after signing, or a different key signed it. This is an offline lead, not a claim about who signed it."));
      continue;
    }
    if (r.timedOut) timedOut = true;
    gap(a, r.reason);
  }
  const reason = `${policy.artifacts.length} artifacts: ${tally.verified} verified, ${tally.invalid} invalid signature, ${tally.unsigned} unsigned, ${tally.gap} unchecked. Key sha256 ${policy.keySha256.slice(0, 12)}`;
  // A missing image is a gap for the engine. The unsigned leads need no tool and stay.
  if (unavailable) return { engine, status: "gap", reason: `${unavailable.reason}. ${reason}`, leads, gaps };
  // Any unchecked artifact makes the engine a gap, so the run view never shows
  // "ran" when cosign did not decide. The leads it did find stay.
  if (tally.gap) return { engine, status: "gap", timedOut, reason: `${tally.gap} of ${policy.artifacts.length} artifact signatures unchecked (${gaps[0].detail.replace(/\.$/, "")}). ${reason}`, leads, gaps };
  return { engine, status: "ok", code: 0, timedOut: false, reason, leads, gaps };
}

// Replay detectors. They read only the pinned snapshot and the evidence `where`.
export function cosignDetectors(opts = {}) {
  const pinned = (snapshot, w) => w && safePath(w.file) && Object.hasOwn(snapshot.files, w.file) && sha(snapshot.files[w.file]) === w.artifactSha256 && w.line === 1;
  return {
    "artifact-signature-missing": async (snapshot, w) => {
      const skipped = new Set((snapshot.skipped ?? []).map((s) => s.file));
      return { ok: Boolean(pinned(snapshot, w) && w.rule === "artifact-signature-missing" && Array.isArray(w.bundles) && w.bundles.length && w.bundles.every((b) => safePath(b) && !Object.hasOwn(snapshot.files, b) && !skipped.has(b))) };
    },
    "tool:cosign": async (snapshot, w) => {
      if (!pinned(snapshot, w) || w.rule !== "cosign/invalid-signature" || !safePath(w.bundle) || !Object.hasOwn(snapshot.files, w.bundle) || sha(snapshot.files[w.bundle]) !== w.bundleSha256) return { ok: false };
      let policy;
      try { policy = parsePolicy({ publicKey: w.publicKey, artifacts: [w.file] }); } catch { return { ok: false }; }
      if (policy.keySha256 !== w.keySha256) return { ok: false };
      const r = await verifyBlob({ artifact: snapshot.files[w.file], bundle: snapshot.files[w.bundle], publicKey: policy.publicKey }, opts);
      return { ok: r.result === "invalid-signature" };
    },
  };
}
