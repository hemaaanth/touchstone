// The Host and network pack: a small server with the three planting decisions a
// real box makes — a password that is in a list you can download, an SUID reader,
// and a world-writable job a root loop runs.
//
// Proof kind: "session" (lib/proof-session.mjs). A finding's command script is
// replayed on a fresh instance with a new random flag behind the bug, so echoing
// a pasted flag cannot pass.
//
// The lab needs the default capability set: `caps: true` drops the
// no-new-privileges flag, which would block the SUID escalation the pack tests.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { event } from "../../lib/event.mjs";
import { attemptCap } from "../../lib/attempt-cap.mjs";
import { requireImage, sessionProof, startTarget, teardownPersistedTarget, writeTargetHandle, runTargetScript, runOpenScript } from "../../lib/proof-session.mjs";
import { sessionTools, leadsTool, flagOracle } from "../../lib/session-tool.mjs";
import { isLive } from "../../lib/live.mjs";
import { readTouchstone } from "../../lib/sandbox.mjs";

const IMAGE = "touchstone/host-lab:1";
const TOOLSET = "touchstone/toolset:1";
const LEADS_FILE = ".host-leads.json";
const MAX_RUNS = attemptCap("MAX_HOST_RUNS");

const ORACLES = [
  flagOracle("host-user-flag", "the replay read the staff account's flag as a shell"),
  flagOracle("host-suid-root", "the SUID reader returned root's flag to an unprivileged shell", { suffix: "-root" }),
  flagOracle("host-root-flag", "a line appended to the world-writable job ran as root and returned root's flag", { suffix: "-cron" }),
];

// Kept for the shared list of oracle names in proof-class.mjs.
export { ORACLES };

const SYSTEM = `You are an authorized offensive-security agent in an isolated lab.
The target is ONE Linux host, reachable as \`target\` on a private network with no
internet. It runs a small web server and sshd. You have a Debian attacker
container has nmap, curl, hydra, sshpass, nc, jq and the usual file tools.
Your job: get an account, then get root, and PROVE each step by capturing a flag
file the lab owns.

Rules of the environment:
- Only run_lab_command reaches the target. It runs a short sh script in the
  attacker container and returns exactly what it printed.
- The target is found by name: nmap -Pn target, curl http://target/, and so on.
  Bound every command (timeouts, small output). Do not scan the whole port range
  more than once.
- The lab plants a flag file per account: one the staff account can read, two only
  root can read. Each replay gets a NEW flag, so extract it — do not paste one.
- After a script runs, the tool tells you whether the output tripped a check. A
  finding is recordable ONLY when it did. Then call submit_finding at once.
- A lead is a lead. Scanners find open ports and titles; the checks need a real
  escalation, so a banner alone is never a finding.

How to work:
- Recon: ports, then the web root, then everything the web root names. A note on
  a server says what the operator forgot.
- One root cause per finding. Three are planted, worst first: the credential path,
  the SUID path, the writable-job path.
- Give each suspect about 4 run_lab_command attempts. If it does not trip a check,
  mark it "not proven" and move on. Come back once the rest are done.
- Not findings: an open port, a server banner, a directory listing, a correct
  login refusal.
- Stop when all three are proven or ruled out, or the budget is spent. Then write
  a coverage summary: one line per suspect, "proven", "not exploitable" or
  "not tried".

Severity: critical = root through a local misconfiguration; high = an unprivileged
account from a discoverable credential; medium = a service that should not be
exposed, with no path to an account; low = information disclosure alone.

Write each explanation so a smart 15-year-old follows it. Simplified Technical
English: short sentences, one idea per sentence. Identifiers in \`backticks\`, code
in fenced blocks whose opening fence names the language (sh). End with a line that
starts with "Fix:". Keep going without asking questions.`;

// A live run has no lab and no planted flag, so nothing can match a capture check.
const LIVE_SYSTEM = `You are an authorized offensive-security agent. The target is a REAL host the
operator named, reached from your attacker container with the host name in
TOUCHSTONE_TARGET. Nothing is a lab, and there is no planted flag: a check cannot
fire, so record what you find as candidates with submit_candidate.

- Recon only from the outside: ports, services, versions, TLS, paths, headers.
- Bound every command (timeouts, small output) and touch only the named host.
- Report one candidate per root cause. State the observed harm separately from the
  potential harm, and the limits of what you could reach.
- Do not claim an exploit you did not run.`;

// The host name of the operator's live scope, as the script container sees it.
function liveHost(ws) {
  const raw = readTouchstone(ws).baseUrl ?? "";
  try {
    return new URL(raw).hostname;
  } catch {
    return raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "").split(":")[0] || null;
  }
}

// A live run has no lab container: the script goes on the bridge network and aims
// at the real host. No flag exists, so no oracle fires and findings are candidates.
function liveRunner(ws, timeoutMs) {
  return (script) => runOpenScript(script, { toolset: TOOLSET, target: liveHost(ws), work: ws, timeoutMs });
}

function readWorkspaceText(ws, name) {
  try {
    return readFileSync(join(ws, name), "utf8").trim();
  } catch {
    return null;
  }
}

function kickoff(ws, env = {}) {
  const leads = env.LEADS && env.LEADS !== "[]" ? env.LEADS : null;
  const live = isLive(ws);
  const parts = [
    live
      ? `Start with the network. The target host is \`${liveHost(ws)}\`, on the open network; there are no planted flags, so record what you find with submit_candidate.`
      : "Start with the network and the web root. The lab is up; the target host is `target`.",
  ];
  if (leads) parts.push(`Pre-pass port sweep (hints only, prove each one):\n${leads}`);
  else parts.push("The pre-pass sweep returned nothing. Scan the host yourself.");
  return parts.join("\n\n");
}

function nudge(state) {
  if (state.found.length === 0) return null;
  return `You have recorded ${state.found.length} finding${state.found.length === 1 ? "" : "s"}. The audit is not done: go back to the suspect list, try every suspect you have not proven or ruled out, then write the coverage summary.`;
}

function tools(ws, state) {
  const live = isLive(ws);
  const { run, submit, submitCandidate } = sessionTools({
    pack: "host",
    ws,
    state,
    oracles: ORACLES,
    cap: MAX_RUNS,
    toolset: TOOLSET,
    hints: live
      ? "No check can fire on a live host. Record what the attempt showed with submit_candidate."
      : "Re-read the target's own output; the lead is usually one step back from here.",
    ...(live ? { runner: liveRunner(ws, 240_000) } : {}),
  });
  const leads = leadsTool(ws, (w) => readWorkspaceText(w, LEADS_FILE), "Read the pre-pass port sweep again. A lead is a hint, never a finding.");
  return [leads, run, submit, submitCandidate];
}

async function prepass(ws) {
  await requireImage(TOOLSET, "toolset");
  const live = isLive(ws);
  let scan;
  if (live) {
    scan = liveRunner(ws, 150_000);
    event("host-scan-started", { live: liveHost(ws) });
  } else {
    await requireImage(IMAGE, "host");
    const handle = await startTarget({ image: IMAGE, caps: true, onStart: (partial) => writeTargetHandle(ws, partial) });
    writeTargetHandle(ws, handle);
    event("host-lab-started", { image: IMAGE });
    scan = (script) => runTargetScript(handle, script, { toolset: TOOLSET, timeoutMs: 120_000 });
  }
  let leads = [];
  try {
    const sweep = await scan(live ? `nmap -Pn --top-ports 50 --open -sT ${liveHost(ws)}` : "nmap -Pn --top-ports 50 --open -sT target");
    leads = sweep.output.split("\n").filter((l) => /^\d+\/tcp\s+open/.test(l.trim())).map((l) => l.trim());
  } catch (err) {
    event("host-scan-failed", { error: String(err?.message ?? err).slice(0, 200) });
  }
  writeFileSync(join(ws, LEADS_FILE), JSON.stringify({ pack: "host", leads }, null, 2));
  event("host-scan-done", { leads: leads.length });
  return { env: { LEADS: JSON.stringify(leads) }, record: { pack: "host", leads } };
}

async function prove(ws, found, _events, log) {
  await teardownPersistedTarget(ws);
  // A live run proved nothing in-session (no flag can fire); replaying is a
  // second attempt at the host, which is still the honest record.
  if (isLive(ws)) {
    const scan = liveRunner(ws, 240_000);
    const out = [];
    for (const f of found ?? []) {
      if (f?.script) {
        try {
          const r = await scan(f.script);
          out.push({ ...f, proof: { kind: "session", status: r.exit === 0 ? "pass" : "fail", detail: `Replayed on the live host, exit ${r.exit}.`, oracle: { name: f.oracleName ?? "", detail: "", passed: false }, log: [{ label: "replayed script", request: { method: "sh", url: "script.sh", headers: {}, body: f.script }, response: { status: r.exit, headers: {}, body: r.output } }] } });
        } catch (err) {
          out.push({ ...f, proof: { kind: "session", status: "fail", detail: `replay infrastructure error: ${String(err?.message ?? err).slice(0, 300)}`, oracle: { name: "", detail: "", passed: false }, log: [] } });
        }
      } else out.push({ ...f, proof: { kind: "session", status: "fail", detail: "no matched script recorded", oracle: { name: "", detail: "", passed: false }, log: [] } });
    }
    return out;
  }
  const out = [];
  for (const f of found ?? []) {
    const oracle = ORACLES.find((o) => o.name === f.oracleName);
    if (!f?.script || !oracle) {
      out.push({ ...f, proof: { kind: "session", status: "fail", detail: "no matched script recorded", oracle: { name: f?.oracleName ?? "", detail: "", passed: false }, log: [] } });
      continue;
    }
    log?.(`replaying #${f.n} ${f.title} on a fresh host (${oracle.name})`);
    try {
      out.push({ ...f, proof: await sessionProof({ image: IMAGE, toolset: TOOLSET, caps: true }, f.script, oracle) });
    } catch (err) {
      out.push({ ...f, proof: { kind: "session", status: "fail", detail: `replay infrastructure error: ${String(err?.message ?? err).slice(0, 300)}`, oracle: { name: oracle.name, detail: "", passed: false }, log: [] } });
    }
  }
  return out;
}

export default {
  id: "host",
  title: "Host and network",
  description: "One Linux box from the outside: open services, a discoverable credential, then local privilege escalation.",
  tier: "P",
  proof: "session",
  live: true,
  // A live host run's scanners (and its scripts) use the host bridge network:
  // they aim at the operator's host, not at a lab.
  scanNet: "open",
  // A real machine with the full toolbelt is where this module is meant to run.
  roam: true,
  system: (ws) => (isLive(ws) ? LIVE_SYSTEM : SYSTEM),
  tools,
  kickoff,
  nudge,
  prepass,
  prove,
  teardown: teardownPersistedTarget,
};

export { IMAGE, TOOLSET, MAX_RUNS };
