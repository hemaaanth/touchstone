// Read a recorded finding's proof without caring which pack made it.
//
// A pack's prove hook returns findings with proof: { kind, status, ... }.
// kind is "forge" (Contracts), "http" or "evidence". A finding recorded before
// kinds existed has a Foundry proof delta with no kind, so it reads as "forge".
// The app server uses these to record, announce and serve findings. Every
// field a pack sends is untrusted: we cap sizes and keep only known fields.
import { createHash } from "node:crypto";

export const PROOF_KINDS = ["forge", "http", "evidence"];

export function proofKind(finding) {
  const k = finding?.proof?.kind;
  return PROOF_KINDS.includes(k) ? k : "forge";
}

// True only when the pack's own replay passed.
// For forge, pocProved is already harm-gated (lib/record.mjs). A proof that says
// the replay failed or showed no harm is never proven, even if pocProved is set.
// A record made before the harm gate has no proof.harm and reads as recorded.
export function isProven(finding) {
  if (!finding) return false;
  if (proofKind(finding) === "forge") {
    const p = finding.proof;
    if (p && (p.pass === false || p.status === "fail" || (p.harm && p.harm.ok !== true))) return false;
    return finding.pocProved === true;
  }
  return finding.proof?.status === "pass";
}

// Stamp pocProved on findings a pack's prove hook returned. A pack that does not
// set it is proven when its own replay passed. A Contracts finding already has
// the field, so it comes back unchanged.
export function withProven(findings) {
  return (findings ?? []).map((f) => (f && f.pocProved === undefined ? { ...f, pocProved: f.proof?.status === "pass" } : f));
}

const str = (v, max = 2000) => (v == null ? "" : String(v).slice(0, max));
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const SECRET_KEY = /secret|private|token|passw|api[-_]?key|credential|authorization|cookie|session/i;

// A value shown on screen. A secret is never shown in full: it is { redacted,
// sha256 }, either as the pack sent it or made here for a secret-looking name.
export function cell(name, value) {
  const v = value;
  if (v && typeof v === "object" && !Array.isArray(v) && "redacted" in v) {
    return { name: str(name, 80), redacted: true, sha256: str(v.sha256, 64) };
  }
  if (SECRET_KEY.test(name) && v != null && typeof v !== "object") {
    return { name: str(name, 80), redacted: true, sha256: createHash("sha256").update(String(v)).digest("hex") };
  }
  return { name: str(name, 80), redacted: false, value: typeof v === "object" ? str(JSON.stringify(v), 400) : str(v, 400) };
}

const headers = (h) => Object.entries(obj(h)).slice(0, 30).map(([k, v]) => cell(k, v));

function exchange(x, i) {
  const q = obj(x?.request);
  const r = obj(x?.response);
  return {
    label: str(x?.label ?? x?.as ?? `Request ${i + 1}`, 80),
    request: { method: str(q.method || "GET", 10), url: str(q.url ?? q.path, 300), headers: headers(q.headers), body: q.body == null ? null : str(typeof q.body === "string" ? q.body : JSON.stringify(q.body), 2000) },
    response: { status: Number.isFinite(Number(r.status)) ? Number(r.status) : null, headers: headers(r.headers), body: r.body == null ? null : str(typeof r.body === "string" ? r.body : JSON.stringify(r.body), 2000) },
  };
}

// The UI shape of one non-forge proof. Returns null for "forge".
export function proofView(finding) {
  const kind = proofKind(finding);
  if (kind === "forge") return null;
  const p = obj(finding.proof);
  const pass = p.status === "pass";
  if (kind === "http") {
    const o = obj(p.oracle);
    return {
      kind, pass,
      oracle: { name: str(o.name ?? o.check ?? "", 120), detail: str(o.detail ?? p.detail, 600), passed: o.passed == null ? pass : Boolean(o.passed) },
      exchanges: (Array.isArray(p.log) ? p.log : Array.isArray(p.exchanges) ? p.exchanges : []).slice(0, 20).map(exchange),
      detail: str(p.detail, 600),
    };
  }
  const e = obj(finding.evidence);
  const where = obj(e.where);
  return {
    kind, pass,
    check: str(p.check ?? e.check, 120),
    snapshotHash: str(p.snapshotHash ?? e.snapshotHash, 64),
    commit: p.commit ? str(p.commit, 64) : null,
    cited: Object.entries(Object.keys(where).length ? where : typeof e.where === "string" ? { where: e.where } : {}).slice(0, 20).map(([k, v]) => cell(k, v)),
    detail: str(p.detail, 600),
  };
}
