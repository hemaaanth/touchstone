// Which replays show harm, and which only show that a measurement repeats.
//
// A finding is Proven only when its replay shows an effect: value moved or
// lost, control taken, a secret or private data read by a party with no right
// to it, code run where it must not run, or data changed without the right.
// A replay that only repeats a measurement (a setting, a version, a missing
// header or record, a scanner grade) is not proof of harm: that result is a
// Candidate, which carries the fact that the measurement was repeated.
//
// This is the one place that decides it (isProven reads it). Each entry below
// is one check kind, so a decision can be flipped by one line. Anything not
// listed is measured: an unknown proof kind, oracle or check is never harm.

// http: the oracles whose verdict is an effect in the replayed transcript.
export const HARM_ORACLES = new Set([
  // web: a captured signature mints a session; another account's data read
  // under a foreign session; a signer key returned to a caller with no
  // credentials. Not here: reflected-xss (no browser ran the script).
  "siwe-nonce-replay",
  "bola-wallet-idor",
  "debug-route-signer-key-leak",
  // ai-mcp: a tool ran that the caller never asked for; a secret left for an
  // outside host; a secret read outside scope; a note deleted or mail sent
  // without the scope. Not here: mcp-tool-definition-rug-pull (no call of
  // the changed tool).
  "prompt-injection-forbidden-tool",
  "prompt-injection-data-exfil",
  "fetch-url-scope-escape",
  "mcp-tool-scope-bypass",
  "tool-description-poisoning",
  // infra-cloud live replay: an attacker credential assumes the role, from
  // the pinned policy in a private moto cloud, and reads a bucket it does not own.
  "assumed-role-reads-other-bucket",
  // The same oracle under the name it had before (infra-cloud validation runs).
  "assumed-role-reads-foreign-bucket",
]);

// evidence: the replay reads the pinned snapshot again and never touches the
// target. Most checks therefore repeat a measurement (a header, a missing
// record), but two report an effect on the reader, so they are harm:
//   - wallet-drainer-behavior: the connect control asks the wallet for a
//     standing approve of value, not just an account. Value is the harm.
//   - subdomain-takeover-fingerprint: the name is claimable by a stranger, so
//     control of it can be taken. Control is the harm.
// The snapshot proves the page at capture time; the class says what the fact
// means, not that the claim was exercised.
export const HARM_CHECKS = new Set([
  "wallet-drainer-behavior",
  "subdomain-takeover-fingerprint",
]);

// forge: the harm verdicts of lib/proof.mjs judgeHarm and keys harmOf.
export const HARM_KINDS = new Set(["funds", "control"]);

// The words a candidate carries for each reason.
export const MEASURED_WORDS = {
  repeated: "Measurement repeated: the replay found the same fact again. It shows no harm.",
  "no-effect": "The replay matched, but it shows no effect on the target.",
  "harm-not-judged": "Harm not judged: recorded before the harm check.",
  unknown: "Unknown proof kind: not counted as proof of harm.",
};

const KINDS = ["forge", "http", "evidence"];
const oracleOf = (f) => f?.proof?.oracle?.name || f?.oracleName || "";
const checkOf = (f) => f?.proof?.check || f?.evidence?.check || "";

// { class: "harm" | "measured", reason, check }. The class of the proof the
// finding carries, read from its check kind. It says nothing about whether the
// replay passed: isProven checks that too.
export function proofClassOf(finding) {
  const p = finding?.proof;
  const kind = p?.kind ?? (p ? "forge" : null);
  if (!KINDS.includes(kind)) return { class: "measured", reason: "unknown", check: String(kind ?? "") };
  if (kind === "forge") {
    const harm = p.harm;
    if (!harm) return { class: "measured", reason: "harm-not-judged", check: "forge" };
    return harm.ok === true && HARM_KINDS.has(harm.kind) ? { class: "harm", reason: null, check: `forge:${harm.kind}` } : { class: "measured", reason: "no-effect", check: "forge" };
  }
  if (kind === "http") {
    const name = oracleOf(finding);
    return HARM_ORACLES.has(name) ? { class: "harm", reason: null, check: name } : { class: "measured", reason: "no-effect", check: name };
  }
  const check = checkOf(finding);
  return HARM_CHECKS.has(check) ? { class: "harm", reason: null, check } : { class: "measured", reason: "repeated", check };
}

export const proofClass = (finding) => proofClassOf(finding).class;
