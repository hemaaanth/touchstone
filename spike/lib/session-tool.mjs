// Shared tools for the machine-layer packs (host, crypto, forensics, binary).
//
// Each of those packs has the same shape: a lab with planted bugs, oracles that
// read a replayed command transcript, and one tool that runs a script. This file
// is that tool plus the finding gate, so the four packs differ only in their lab,
// their oracles and their prompt.
//
// The tool's job for the agent is to REPORT HONESTLY whether the transcript
// tripped an oracle. A finding is only recordable from a matched label, the same
// rule the web pack uses. Unlike web there is no proxy: the frame markers and the
// per-instance flag are what keep a replay from being forged (lib/proof-session.mjs).
import { event } from "./event.mjs";
import { candidateTool } from "./candidate.mjs";
import { defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { sha256 } from "./proof-evidence.mjs";
import { parseRun, readTargetHandle, runTargetScript } from "./proof-session.mjs";

export const SESSION_POC = "the label of a run_lab_command attempt that tripped one of this module's checks";

// The oracles a pack ships all take (run, { flag }). This wrapper is the one
// place an oracle's throw is contained: a broken check fails that check only.
export function matchOracle(oracles, run, context) {
  for (const oracle of oracles) {
    let verdict;
    try {
      verdict = oracle.check(run, context);
    } catch {
      continue;
    }
    if (verdict?.pass) return { oracle, verdict };
  }
  return null;
}

// Only the flag comparison is universal. `flagOracle` is the exact check every
// pack uses for a planted flag. `suffix` separates several queued harms: "" is the
// bare flag (which must not match a longer "-zip" style value), "-zip" the zipped
// one. Packs add narrower checks beside these.
export function flagOracle(name, what, { suffix = "" } = {}) {
  return {
    name,
    check(run, { flag } = {}) {
      if (!flag) return { pass: false, detail: "no per-instance flag to compare against" };
      const want = flag + suffix;
      const hit = suffix
        ? run.output.includes(want)
        : new RegExp(`${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!-)(?=[\\s\\n]|$)`, "m").test(run.output);
      return hit
        ? { pass: true, detail: `${what} — the replay got this instance's flag (${want}), which the live session never saw.` }
        : { pass: false, detail: `${what} did not appear: ${want} is not in the output` };
    },
  };
}

export function recordSession(state, label, script, run, matched) {
  state.attempts ??= new Map();
  state.attempts.set(String(label), { script: String(script), output: run.output, exit: run.exit, matched: Boolean(matched) });
}

// Candidate evidence for an unmatched attempt: the exact script and its output,
// so submit_candidate can never cite something the tool did not produce.
export function sessionLookup(state) {
  return (label) => {
    const a = state.attempts?.get(label);
    if (!a) return null;
    if (a.matched || state.passed.has(label)) return { proved: true };
    return {
      evidence: { kind: "transcript", script: a.script, output: a.output, exit: a.exit },
      text: `$ sh script.sh\nexit ${a.exit}\n${a.output}`,
      rootCause: `script:${sha256(a.script).slice(0, 16)}`,
    };
  };
}

// The pack's own leftovers from its pre-pass, read back by the agent.
export function leadsTool(ws, readLeads, description) {
  return defineTool({
    name: "lab_leads",
    description,
    parameters: obj({}),
    replay: "safe",
    execute: async () => ({ output: [{ type: "text", text: readLeads(ws) ?? "No pre-pass leads were recorded for this run." }] }),
  });
}

// The classic one-liner marker a pack sets on its own container/env so the tool
// knows a live target exists.
export function requireLive(ws) {
  const handle = readTargetHandle(ws ?? "");
  if (!handle) throw new Error("The target is not running (no persisted handle). This is an infrastructure error, not something your script can fix.");
  return handle;
}

// run_lab_command + submit_finding for one pack.
//   ws        the run workspace (falls back to TOUCHSTONE_WS)
//   runner    optional (script) => run. An open live scope has no target handle,
//             so a pack with a live lane passes its own runner.
//   state     the audit state ({ poc, passed, found, attempts })
//   oracles   the pack's ORACLES, in pack order
//   cap       attempt ceiling for the whole run
//   toolset   attacker image
//   timeoutMs script wall clock
//   scrub/scrubLine  redactors for candidate text
//   hints     one line the tool appends when nothing matched
export function sessionTools({ pack, ws, state, oracles, cap, toolset, timeoutMs = 180_000, scrub, scrubLine, hints, runner }) {
  const leftText = (used) => `This run allows ${cap} lab command runs in total and you have used ${used}.`;

  const run = defineTool({
    name: "run_lab_command",
    description: "Run one bounded shell script inside the lab's attacker container (Debian syntax, `sh`) and read exactly what it printed. Give each attempt a short unique label; pass the same label to submit_finding if this attempt trips a check. Keep it to a handful of commands: `-x`-style noise is not recorded, only the framing the tool adds. The target is reachable as `target` (and the artifacts, where the module gives you any, are in /work).",
    parameters: obj({
      label: str({ description: "short, unique name for this attempt, e.g. \"sqli-1\"" }),
      script: str({ description: "sh script source. Bound every command: finite timeouts, small output." }),
    }),
    replay: "unsafe",
    execute: async (args) => {
      const attempt = ++state.poc;
      if (attempt > cap) {
        event("run_lab_command-capped", { attempt });
        const unsent = [...state.passed.keys()].filter((label) => !state.found.some((f) => f.poc === label));
        const hint = unsent.length ? ` These matched attempts are not submitted yet: ${unsent.join(", ")}. Submit any that prove a new root cause.` : "";
        return { output: [{ type: "text", text: `Command budget exhausted (${cap} runs used).${hint} Stop running commands and write the coverage summary.` }], isError: true };
      }
      const work = ws ?? process.env.TOUCHSTONE_WS ?? "";
      let handle;
      try {
        handle = runner ? null : requireLive(work);
      } catch (err) {
        return { output: [{ type: "text", text: String(err?.message ?? err) }], isError: true };
      }
      event("run_lab_command", { label: args.label, attempt });
      let result;
      try {
        result = runner
          ? await runner(String(args.script))
          : await runTargetScript(handle, String(args.script), { toolset, work, timeoutMs });
      } catch (err) {
        event("run_lab_command-done", { label: args.label, ok: false });
        return { output: [{ type: "text", text: `Script failed to run: ${String(err?.message ?? err).slice(0, 300)}` }], isError: true };
      }
      // A live target has no planted flag, so no oracle can fire; the candidate
      // path is the record there.
      const match = matchOracle(oracles, result, { flag: handle?.flag });
      if (match) state.passed.set(String(args.label), { script: String(args.script), oracleName: match.oracle.name });
      recordSession(state, args.label, args.script, result, match);
      event("run_lab_command-done", { label: args.label, exit: result.exit, matched: match?.oracle.name ?? null, ...(result.timedOut ? { timedOut: true } : {}) });
      const clock = result.timedOut ? `\n\nThe script hit its ${Math.round(timeoutMs / 1000)} s wall clock and was killed. The output above is what it printed before that. Split the work into a shorter script.` : "";
      const verdict = match
        ? `\n\nMATCH: ${match.oracle.name} — ${match.verdict.detail}\nThis is a real proof. Call submit_finding now with label "${args.label}", unless this same root cause is already recorded.`
        : `\n\nNo check matched this transcript. ${hints ?? ""}`;
      return {
        output: [{
          type: "text",
          text: `$ sh script.sh\nexit ${result.exit}${result.timedOut ? " (killed)" : ""}\n${result.output || "(no output)"}${clock}${verdict}\n\n(${leftText(attempt)})`,
        }],
      };
    },
  });

  const submit = defineTool({
    name: "submit_finding",
    description: "Record one proven vulnerability: one root cause. Call it right after run_lab_command reports a MATCH for a label. Never submit a second finding for the same root cause.",
    parameters: obj({
      title: str({ description: "short title for the finding" }),
      severity: str({ description: "critical | high | medium | low" }),
      label: str({ description: "the label of the run_lab_command attempt that reported a MATCH" }),
      explanation: str({ description: "plain-language write-up: what happened, why it matters, ending with a line starting \"Fix:\"" }),
    }),
    replay: "safe",
    execute: async (args) => {
      const label = String(args.label ?? "").trim();
      const entry = state.passed.get(label);
      if (!entry) {
        event("submit-rejected", { label, reason: "not-matched" });
        const why = runner
          ? `This is a live target: no check can fire, so findings come from submit_candidate.`
          : `Run a script that trips a check, then call submit_finding again with that label.`;
        return { output: [{ type: "text", text: `Cannot record this finding: label "${label}" has no run_lab_command attempt in this session that matched a check. ${why}` }], isError: true };
      }
      const dupLabel = state.found.find((f) => f.poc === label);
      if (dupLabel) {
        event("submit-rejected", { label, reason: "duplicate-label" });
        return { output: [{ type: "text", text: `"${label}" is already recorded as finding #${dupLabel.n} ("${dupLabel.title}").` }], isError: true };
      }
      const dupRoot = state.found.find((f) => f.oracleName === entry.oracleName);
      if (dupRoot) {
        event("submit-rejected", { label, reason: "duplicate-root-cause" });
        return { output: [{ type: "text", text: `A finding for this same root cause is already recorded as #${dupRoot.n} ("${dupRoot.title}"). One finding per root cause — continue with the next suspect instead.` }], isError: true };
      }
      const n = state.found.length + 1;
      const finding = { n, title: String(args.title), severity: String(args.severity), poc: label, explanation: String(args.explanation), script: entry.script, oracleName: entry.oracleName };
      state.found.push(finding);
      event("finding-submitted", { pack, n, title: finding.title, severity: finding.severity, poc: label });
      return { output: [{ type: "text", text: `Recorded finding #${n}: ${finding.title} (${finding.severity}). Do NOT stop. Continue auditing for other root causes. (${leftText(state.poc)}) When every suspect is proven or ruled out, write the coverage summary.` }] };
    },
  });

  const submitCandidate = candidateTool({ pack, state, lookup: sessionLookup(state), poc: SESSION_POC, scrub: scrub ?? ((v) => v), scrubLine: scrubLine ?? ((t) => t) });

  return { run, submit, submitCandidate };
}

export { parseRun };
