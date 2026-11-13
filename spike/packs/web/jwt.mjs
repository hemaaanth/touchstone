// jwt_tool JWT-key cracking for the Web pack's prepass. The lab's v2 session
// API (GET /api/v2/token) hands out HS256 JSON Web Tokens. jwt_tool, given one
// such token and a dictionary, tries each word as the HMAC signing key and
// stops when a word reproduces the token's signature. A weak, dictionary-
// crackable key is a real auth hole: once the key is known, an attacker forges
// a token with any claims (e.g. role:"admin") and the server's signature check
// passes. None of the pack's HTTP scanners (zap, nuclei, dalfox, ffuf, arjun,
// schemathesis) crack a signing key, so this is the one tool that finds it.
//
// Two containers, two jobs:
//   1. Capture: a tiny node client on the lab network (`net`) GETs one token
//      from `baseUrl`. This is the only step that touches the target, and it
//      only reads the public token-issuing endpoint.
//   2. Crack: jwt_tool runs with NO network at all (--network none). Cracking is
//      pure local computation over the captured token and jwt_tool's bundled
//      wordlist; it never calls home or re-contacts the target.
//
// The image is pinned and built locally (Dockerfile.jwt_tool) and every run
// uses --pull=never, so jwt_tool only ever sees the one token we hand it.
//
// A cracked key is a LEAD, never a finding. "This token's signing key is the
// dictionary word X" is a hint; the agent must still forge a token, replay it,
// and show an oracle the privilege escalation it buys.
import { runTool } from "../../lib/wrap.mjs";
import { isTimeout } from "./toolrun.mjs";

// Built by spike/scripts/build-labs.sh from packs/web/Dockerfile.jwt_tool.
export const JWT_TOOL_IMAGE = "touchstone/web-jwt-tool:2.3.0";

// jwt_tool exits 1 after its crack branch, whether it cracked the key or missed.
// A verdict line printed under ANY other exit code means the process did not
// finish that branch the way jwt_tool does, so the marker cannot be trusted.
export const JWT_TOOL_CRACK_EXIT = 1;

// The token-capture client. node:20-slim is already local (startLab uses it as
// the recording proxy), so --pull=never is satisfied without a registry.
export const FETCH_IMAGE = "node:20-slim";

// The public endpoint that issues a v2 JWT, and jwt_tool's bundled dictionary.
export const TOKEN_PATH = "/api/v2/token";
const WORDLIST = "/opt/jwt_tool/jwt-common.txt";

const cap = (s, n = 200) => String(s ?? "").slice(0, n);

// A JWT is three base64url segments joined by dots. This is a shape check only
// (not a verification): it tells us the capture produced something crackable.
export function looksLikeJwt(token) {
  const t = String(token ?? "").trim();
  if (!t) return false;
  const parts = t.split(".");
  return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p));
}

// ---- crack-output reader: a pure function over jwt_tool's stdout.
//
// jwt_tool ALWAYS exits 1 after its crack branch -- success or failure -- so
// the exit code cannot tell "cracked" from "not cracked" from "broke". The
// ground truth is the text. A crack prints "[+] <key> is the CORRECT key!"
// (short keys) or "[+] CORRECT key found:\n<key>" (long keys); a clean miss
// prints "[-] Key not in dictionary". Anything else -- empty output, a decode
// error, a half-run -- is NOT a clean "nothing found"; it is an unusable run.
//
// Returns:
//   { analyzed: true,  cracked: true,  secret }  a key was recovered
//   { analyzed: true,  cracked: false, secret: null }  ran, key not in dict
//   { analyzed: false, cracked: false, secret: null }  no usable verdict (gap)
export function parseJwtCrack(stdout) {
  const text = String(stdout ?? "");
  // "[+] <key> is the CORRECT key!" -- the common, short-key form.
  const inline = text.match(/\[\+\]\s+(.*?)\s+is the CORRECT key!/);
  if (inline) return { analyzed: true, cracked: true, secret: cap(inline[1], 120) };
  // "[+] CORRECT key found:\n<key>" -- the long-key form (key on next line).
  const found = text.match(/\[\+\]\s+CORRECT key found:\s*\n\s*(.+)/);
  if (found) return { analyzed: true, cracked: true, secret: cap(found[1].trim(), 120) };
  // A clean, complete run that simply did not crack the key.
  if (/Key not in dictionary/.test(text)) return { analyzed: true, cracked: false, secret: null };
  // No marker at all: the token never got analysed (missing image, decode
  // failure, killed run). Fail closed -- this is a gap, not a clean result.
  return { analyzed: false, cracked: false, secret: null };
}

// Turn a crack result into leads. A cracked key is one High-impact lead on the
// token-issuing endpoint; a clean miss is []. `verdict` is parseJwtCrack's
// return. Only call this when verdict.analyzed is true.
export function jwtLeads(verdict) {
  if (!verdict?.cracked) return [];
  const secret = cap(verdict.secret, 120);
  // shortcut: the lead carries the cracked word; fine for the lab key, redact
  // before these tools run on a live target.
  return [{
    engine: "jwt-tool",
    check: "jwt-weak-hmac-key",
    impact: "High",
    where: `${TOKEN_PATH} (HS256 signing key is dictionary word "${secret}")`,
    path: TOKEN_PATH,
    description: cap(`jwt_tool recovered the HS256 signing key for the JWT issued at ${TOKEN_PATH} from a dictionary: the key is "${secret}". A guessable HMAC key means an attacker can forge a token with any claims (e.g. an admin role) and pass the server's signature check. A lead: the agent must forge a token, replay it against a protected route (e.g. /api/v2/admin/summary), and prove the escalation with an oracle.`, 240),
  }];
}

// The capture client script. Reads the target URL from an env var (no shell
// quoting, no interpolation into code) and writes only the token to stdout.
const FETCH_SCRIPT = `
fetch(process.env.TARGET + ${JSON.stringify(TOKEN_PATH)})
  .then((r) => r.json())
  .then((j) => { if (j && typeof j.token === "string") process.stdout.write(j.token); else process.exit(4); })
  .catch(() => process.exit(3));
`;

// ---- runner
//
// Run the capture + crack chain against { net, baseUrl }. Always resolves;
// never throws. Fails closed at every step: a capture that yields no JWT, a
// crack that times out, or a crack with no usable verdict is reported
// "unavailable" with a reason, never a clean "found nothing". A completed crack
// (key recovered, or honestly not in the dictionary) is "ran". Returns
// { coverage, leads } in scanWeb's shape.
export async function scanJwt({
  net,
  baseUrl,
  run = runTool,
  fetchTimeoutMs = 20_000,
  crackTimeoutMs = 60_000,
} = {}) {
  const unavailable = (reason, code = 1, timedOut = false) => ({
    coverage: [{ engine: "jwt-tool", status: "unavailable", code, timedOut: Boolean(timedOut), leads: 0, reason: cap(reason, 220) }],
    leads: [],
  });

  // Step 1: capture a token from the lab, over the network, nothing else.
  const cap1 = await run({
    image: FETCH_IMAGE, network: net, timeoutMs: fetchTimeoutMs,
    env: { TARGET: baseUrl }, cmd: ["node", "-e", FETCH_SCRIPT],
  });
  const token = String(cap1.stdout ?? "").trim();
  if (isTimeout(cap1.code, cap1.timedOut)) {
    return unavailable(`token capture from ${TOKEN_PATH} timed out; cannot analyse a JWT we never got. ${cap(cap1.stderr, 100)}`, cap1.code, true);
  }
  if (!looksLikeJwt(token)) {
    return unavailable(`could not capture a JWT from ${TOKEN_PATH} (exit ${cap1.code}); the target did not return a usable token, so there is nothing to crack. ${cap(cap1.stderr, 120)}`, cap1.code);
  }

  // Step 2: crack the captured token, OFFLINE (--network none).
  const r = await run({
    image: JWT_TOOL_IMAGE, network: "none", timeoutMs: crackTimeoutMs,
    env: { NO_COLOR: "1" },
    cmd: ["python3", "/opt/jwt_tool/jwt_tool.py", token, "-C", "-d", WORDLIST],
  });
  // jwt_tool always exits 1 after cracking, so test the timeout flags/codes
  // (137/143/124), not a bare non-zero exit.
  if (isTimeout(r.code, r.timedOut)) {
    return unavailable(`jwt_tool timed out after ~${Math.round(crackTimeoutMs / 1000)}s (exit ${r.code}); no result from a killed crack is trustworthy. ${cap(r.stderr, 100)}`, r.code, true);
  }
  const verdict = parseJwtCrack(r.stdout);
  if (!verdict.analyzed) {
    return unavailable(`jwt_tool produced no usable verdict (no crack result and no "not in dictionary" line); a gap, not a clean run. exit ${r.code}. ${cap(r.stderr, 120)}`, r.code);
  }
  // A verdict is only trustworthy when it comes with the exit code jwt_tool
  // actually gives after a completed crack (1). A marker line under any other
  // non-timeout code is an inconsistent run; fail closed rather than read it.
  if (r.code !== JWT_TOOL_CRACK_EXIT) {
    return unavailable(`jwt_tool printed a verdict but exited ${r.code}, not the ${JWT_TOOL_CRACK_EXIT} it gives after a completed crack; an inconsistent run is a gap, not a result. ${cap(r.stderr, 100)}`, r.code);
  }
  const leads = jwtLeads(verdict);
  return {
    coverage: [{ engine: "jwt-tool", status: "ran", code: r.code, timedOut: false, leads: leads.length }],
    leads,
  };
}
