// Keep secrets out of what a proof stores and the app renders.
//
// The oracles read the RAW transcript. Their `detail` text and the stored
// `proof.log` go to the app, so both are scrubbed first. A secret is shown as
// "[REDACTED sha256:<first 12>]". The hash lets a reader match two sightings of
// one secret without seeing it. Shared by the web and ai-mcp packs.
import { redactSecret } from "../../lib/proof-evidence.mjs";

// Field names that hold a secret (same idea as the viewer's name rule).
const SECRET_NAME = /secret|private|token|passw|api[-_]?key|credential|authorization|cookie|session/i;
// Secret shapes that can sit inside any text.
const SHAPES = [
  /(?:0x)?[0-9a-fA-F]{64}/g, // hex signing key
  /sk-lab-[0-9a-f]{16}/g, // the lab's internal API key
  /PAYROLL-KEY-[0-9a-f]+/g, // the lab's confidential payroll note
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
];
// A `"name":"value"` pair inside text, where the name looks secret.
const PAIR = /("(?:[^"\\]*(?:secret|private|token|passw|api[-_]?key|credential)[^"\\]*)"\s*:\s*")([^"]+)(")/gi;

// "[REDACTED sha256:abcdef012345]" for one secret value.
export function fp(value) {
  return `[REDACTED sha256:${redactSecret(value).sha256.slice(0, 12)}]`;
}

// `extra` is a list of RegExp the caller configured on top of the built-in
// shapes (for example the ai-mcp pack's TOUCHSTONE_MCP_SECRET_PATTERNS). The
// oracles detect with those patterns, so the stored proof must scrub with them.
const globalOf = (re) => (re.global ? re : new RegExp(re.source, re.flags + "g"));
export function scrubText(text, extra = []) {
  let out = String(text);
  out = out.replace(PAIR, (_m, a, v, c) => `${a}${fp(v)}${c}`);
  for (const re of [...SHAPES, ...extra.map(globalOf)]) out = out.replace(re, (m) => (m ? fp(m) : m));
  return out;
}

// A body (object, array or string) with every secret replaced. Returns a copy.
export function scrubBody(value, name = "", extra = []) {
  if (value == null) return value;
  if (typeof value === "string") return SECRET_NAME.test(name) && value ? fp(value) : scrubText(value, extra);
  if (typeof value !== "object") return SECRET_NAME.test(name) && value !== "" ? fp(value) : value;
  if (Array.isArray(value)) return value.map((v) => scrubBody(v, name, extra));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubBody(v, k, extra)]));
}

// A finished http proof with no raw secret left in it. Run this right after
// httpProof returns. The oracle has already decided, so only text changes.
export function scrubProof(proof, extra = []) {
  const scrub = (b) => scrubBody(b, "", extra);
  const text = (t) => scrubText(t, extra);
  return {
    ...proof,
    detail: text(proof.detail ?? ""),
    oracle: proof.oracle ? { ...proof.oracle, detail: text(proof.oracle.detail ?? "") } : proof.oracle,
    log: (proof.log ?? []).map((x) => ({
      ...x,
      label: text(x.label ?? ""),
      request: { ...x.request, url: text(x.request?.url ?? ""), body: scrub(x.request?.body) },
      response: { ...x.response, body: scrub(x.response?.body) },
    })),
  };
}
