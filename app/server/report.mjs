// The shareable report — a finished run's finding, its proof, the harm, the fix.
//
// WHY THIS EXISTS. A finished run holds a real finding and a proof that replays.
// A case study needs that in one self-contained page someone can read and share:
// what was found, how bad it is, the proof that it is real, the harm the proof
// showed, and the fix. This module turns one normalized finding (findings.mjs)
// into that page.
//
// HONEST BY CONSTRUCTION. The finding shape carries no "fix" field. The engine's
// prose explanation may carry a "Fix:" line; if it does, we show it as the fix.
// If it does not, the report says the run did not state a fix. We never invent a
// remediation. The harm is read from the proof that actually replayed: the
// Foundry transfers and gas for a forge proof, the request-and-response oracle
// for an http proof, the checked snapshot for an evidence proof. An unproven
// finding is labelled as such; the report never calls a lead a finding.
//
// SELF-CONTAINED. renderReportHtml returns one HTML string with inline CSS, the
// inline logo mark, no script and no remote asset, so the file opens anywhere
// and shares cleanly. Its colours and font come from the app's own files
// (brand.mjs), so it looks like the console and cannot drift from it. The three
// builders are pure: buildReport(finding) -> report; the renderers take that
// report. That keeps them unit-testable with a finding object and no server.

import { FONT_MONO, FONT_SANS, brandCss, markSvg } from "./brand.mjs"
import { redactSecrets } from "./redact.mjs"

// Pull the fix and the harm narrative out of the engine's prose explanation.
// The engine writes free prose; by convention a remediation sits under a "Fix:"
// label or a "## Fix" heading, and the proof narrative under "PoC"/"Proof". We
// read only what is labelled. Anything we cannot label stays in `narrative`, so
// nothing is dropped and nothing is relabelled as a fix.
export function splitExplanation(explanation) {
  const text = String(explanation || "").replace(/\r\n/g, "\n").trim();
  if (!text) return { fix: null, narrative: "" };
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  let fix = null;
  const rest = [];
  let heading = null;
  for (const block of blocks) {
    const atx = /^#{1,6}\s+(.+?)\s*#*$/.exec(block);
    if (atx && !/\n/.test(block)) { heading = atx[1].trim(); continue; }
    if (/^fix\b/i.test(block) || /^fix$/i.test(heading || "")) {
      const body = /^fix\s*:?\s*/i.test(block) ? block.replace(/^fix\s*:?\s*/i, "") : block;
      fix = fix ? `${fix}\n\n${body}` : body;
      heading = null;
      continue;
    }
    heading = null;
    rest.push(block);
  }
  return { fix: fix || null, narrative: rest.join("\n\n") };
}

// Read the harm the proof actually showed, per proof kind. Returns plain lines a
// reader can check, never a claim the proof did not make. The field names here
// are the real recorded shapes: a forge proof (findings.mjs) carries `balances`
// (before/after rows), `transfers` (signed ETH deltas), and `gas`; an http proof
// (proof-view.mjs) carries an `oracle` and request/response `exchanges`; an
// evidence proof carries a `check` against a pinned snapshot.
function harmOf(finding) {
  const kind = finding.proofKind;
  const proof = finding.proof || {};
  const lines = [];
  if (kind === "forge") {
    if (proof.pass && proof.test) lines.push(`A Foundry test (${proof.test}) replays green offline and shows the harm.`);
    // The money the exploit moved, read from the Foundry trace of the replay.
    for (const b of Array.isArray(proof.balances) ? proof.balances : []) {
      if (b.before !== b.after) lines.push(`${b.label}: ${b.before} → ${b.after}.`);
    }
    for (const t of Array.isArray(proof.transfers) ? proof.transfers : []) {
      lines.push(`${t.label || t.address || "an account"} ${t.gained ? "gained" : "lost"} ${t.net ?? "?"}.`);
    }
    if (proof.gas != null) lines.push(`Gas used in the replay: ${proof.gas}.`);
  } else if (kind === "http") {
    const o = proof.oracle || {};
    if (o.name || o.detail) {
      const name = o.name ? `"${o.name}" ` : "";
      lines.push(`The oracle ${name}${o.passed ? "fired" : "did not fire"}${o.detail ? `: ${o.detail}` : "."}`.replace(/\.?$/, "."));
    }
    const ex = Array.isArray(proof.exchanges) ? proof.exchanges : [];
    if (ex.length) {
      lines.push(`${ex.length} request/response exchange${ex.length === 1 ? "" : "s"} replayed against the practice service on a private network.`);
      const last = ex[ex.length - 1];
      if (last?.response?.status != null) lines.push(`The target answered ${last.response.status} to ${last.request?.method || "GET"} ${last.request?.url || ""}.`.trim());
    }
    if (proof.detail) lines.push(String(proof.detail).trim());
  } else if (kind === "evidence") {
    if (proof.check) lines.push(`The check "${proof.check}" still holds against a pinned snapshot${proof.commit ? ` at commit ${proof.commit}` : ""}.`);
    if (proof.detail) lines.push(String(proof.detail).trim());
  }
  if (!lines.length) lines.push("The proof record carries no machine-readable harm detail; see the proof below.");
  return lines;
}

// Build the report from one normalized finding (findings.mjs getFinding).
export function buildReport(finding) {
  if (!finding || typeof finding !== "object") throw new Error("buildReport needs a finding object.");
  const { fix, narrative } = splitExplanation(finding.explanation);
  const proven = Boolean(finding.stages?.proven);
  // The leads the pre-pass raised, if any, so the report shows where the hunt
  // started. We summarize; the full prepass stays in the finding record.
  const leads = [];
  for (const s of finding.staticScan?.top || []) leads.push({ from: finding.staticScan.tool || "static", check: s.check, impact: s.impact, where: s.where });
  for (const s of finding.fuzzScan?.top || []) leads.push({ from: finding.fuzzScan.tool || "fuzz", check: s.check, impact: s.impact, where: s.where });

  // Mask bearer tokens and other secrets last, so every format (html, markdown,
  // json) is built from the same redacted report. Header names and proof
  // facts stay; only the secret values change.
  return redactSecrets({
    id: finding.id,
    runId: finding.runId,
    title: finding.title || "Untitled finding",
    severity: finding.severity || null,
    module: finding.module || finding.pack || null,
    target: typeof finding.target === "string" ? finding.target : (finding.target?.title || null),
    // The scope the run used, when the run recorded one (newer runs).
    scope: finding.scope?.title || null,
    // When the run started: the first recorded engine event. Null when the run
    // kept no events, so the report says the date was not recorded.
    runAt: Number.isFinite(finding.events?.[0]?.t) ? finding.events[0].t : null,
    proofKind: finding.proofKind || null,
    proven,
    // The verdict ladder, as findings.mjs recorded it. Each stage is true only
    // because the data shows it.
    stages: {
      hypothesis: Boolean(finding.stages?.hypothesis),
      reproduced: Boolean(finding.stages?.reproduced),
      proven,
    },
    dismissed: finding.stages?.accepted === "dismissed",
    // A plain, honest status line for the top of the report.
    status: proven
      ? "Proven: the proof replays and shows the harm."
      : "Not proven: this is a lead or an in-progress finding, not a replayed proof.",
    // What the agent read to start the hunt. This is the source it opened, which
    // can be a whole file; a case study wants the lead, not the file, so we show a
    // preview and say it is one. The full source rides along in the proof's
    // testSource. Null stays null so the section is dropped.
    hypothesis: preview(finding.hypothesis, 900),
    narrative: narrative || null,
    harm: harmOf(finding),
    // The fix, only if the run stated one. Never invented.
    fix: fix,
    fixStated: Boolean(fix),
    leads,
    proof: finding.proof || null,
    meta: {
      model: finding.model || null,
      usd: finding.usage?.usd ?? null,
      ms: finding.ms ?? null,
      generatedAt: Date.now(),
    },
  });
}

// A preview of a long text: the head, with a clear marker when it was cut, so a
// report never silently drops the tail. Returns null for empty input.
function preview(text, max) {
  const s = String(text || "").trim();
  if (!s) return null;
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + `\n\n[… truncated; the full source rides in the proof below.]`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// A small, safe Markdown subset for the engine's prose: headings, fenced code,
// lists, paragraphs, and inline code, bold and italic. Everything is escaped
// first, so finding text can never become live HTML.
function inline(text) {
  return String(text)
    .split(/(`[^`]+`)/)
    .map((part) =>
      /^`[^`]+`$/.test(part)
        ? `<code>${esc(part.slice(1, -1))}</code>`
        : esc(part)
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
            .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1<em>$2</em>"),
    )
    .join("")
}

function markdown(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n")
  const out = []
  let para = []
  let list = null
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`)
    para = []
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`)
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^\s*```/.exec(line)
    if (fence) {
      flush()
      const code = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i])
      out.push(`<pre class="code">${esc(code.join("\n"))}</pre>`)
      continue
    }
    const h = /^#{1,6}\s+(.+?)\s*#*$/.exec(line)
    if (h) { flush(); out.push(`<h4>${inline(h[1])}</h4>`); continue }
    const li = /^\s*(?:([-*])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (li) {
      if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = [] }
      const tag = li[2] ? "ol" : "ul"
      if (list && list.tag !== tag) flush()
      list = list || { tag, items: [] }
      list.items.push(li[3])
      continue
    }
    if (!line.trim()) { flush(); continue }
    if (list && /^\s+\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue }
    if (list) flush()
    para.push(line.trim())
  }
  flush()
  return out.join("\n")
}

// The icons the app's StatusMark uses (lucide check, minus), inline.
const ICON = {
  check: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`,
  minus: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/></svg>`,
  x: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
}

// The note under the finding title, by proof kind. The same words as the chat's
// finding card (src/components/run-thread.tsx CARD_NOTE). A saved report is a
// settled run, so only the settled states apply: proven or not reproduced.
const NOTE = {
  forge: { proven: "A clean Foundry replay reproduced the exploit.", unproven: "Recorded, but the final replay did not reproduce it." },
  http: { proven: "A clean replay of the request showed the harm.", unproven: "Recorded, but the final replay did not show the harm." },
  evidence: { proven: "The pinned evidence replayed and the check still holds.", unproven: "Recorded, but the pinned evidence did not replay." },
}
const PROOF_NAME = { forge: "Foundry test", http: "HTTP replay", evidence: "Pinned evidence" }

// Severity colour, as in the app (src/lib/format.ts severityTone): red for
// critical and high, amber for medium. Colour only once a replay proved it.
function sevInk(r) {
  const s = String(r.severity || "").toLowerCase()
  if (!r.proven) return "muted"
  return s === "critical" || s === "high" ? "bad" : s === "medium" ? "warn" : "muted"
}

const when = (ms) => new Date(ms).toISOString().replace("T", " ").replace(/:\d\d\.\d+Z$/, " UTC")

// A label and a value, in the proof card's fact grid. Empty values are dropped.
const fact = (label, value, mono = false) =>
  value == null || value === "" ? "" : `<div><dt>${esc(label)}</dt><dd${mono ? ' class="mono"' : ""}>${esc(value)}</dd></div>`

const fold = (summary, body, extra = "") => `<details${extra}><summary>${summary}</summary><div class="fold">${body}</div></details>`

const cellText = (c) => (c.redacted ? `redacted · sha256 ${String(c.sha256 || "").slice(0, 12)}…` : c.value)

// The proof card body: what was replayed or executed, per proof kind.
function proofBody(r) {
  const p = r.proof || {}
  if (r.proofKind === "forge") {
    const runs = Array.isArray(p.runs) ? p.runs : []
    const failed = runs.filter((x) => !x.pass).length
    const attempts = runs.length ? `${runs.length} (${failed} failed, last ${runs[runs.length - 1].pass ? "passed" : "failed"})` : null
    const proving = [...runs].reverse().find((x) => x.pass) || runs[runs.length - 1]
    const asserts = Array.isArray(p.assertions) && p.assertions.length
      ? `<h3>What the test asserts</h3><ul class="asserts">${p.assertions.map((a) => `<li><code>${esc(a)}</code></li>`).join("")}</ul>`
      : ""
    return `<dl class="facts">${fact("Tool", p.tool || "Foundry")}${fact("Test", p.test, true)}${fact("Contract", p.contract, true)}${fact("Compiler", p.compiler)}${fact("Gas", p.gas != null ? Number(p.gas).toLocaleString("en-US") : null)}${fact("Attempts", attempts)}</dl>
      ${p.rerunCommand ? `<h3>Replay it</h3><pre class="code">${esc(p.rerunCommand)}</pre>` : ""}
      ${asserts}
      ${proving?.raw ? fold(`Replay output · attempt ${esc(proving.n ?? runs.length)} · ${proving.pass ? "passed" : "failed"}`, `<pre class="code">${esc(proving.raw)}</pre>`) : ""}
      ${p.testSource ? fold("Test source", `<pre class="code">${esc(p.testSource)}</pre>`) : ""}`
  }
  if (r.proofKind === "http") {
    const o = p.oracle || {}
    const ex = Array.isArray(p.exchanges) ? p.exchanges : []
    const rows = ex.map((x) => `<tr><td>${esc(x.label)}</td><td class="mono">${esc(x.request?.method || "GET")} ${esc(x.request?.url || "")}</td><td class="mono">${esc(x.response?.status ?? "—")}</td></tr>`).join("")
    const detail = ex.map((x) => {
      const hs = (h) => (Array.isArray(h) ? h : []).map((c) => `${c.name}: ${cellText(c)}`).join("\n")
      const req = [`${x.request?.method || "GET"} ${x.request?.url || ""}`, hs(x.request?.headers), x.request?.body].filter(Boolean).join("\n")
      const res = [`${x.response?.status ?? ""}`, hs(x.response?.headers), x.response?.body].filter(Boolean).join("\n")
      return fold(esc(x.label), `<h3>Request</h3><pre class="code">${esc(req)}</pre><h3>Response</h3><pre class="code">${esc(res)}</pre>`)
    }).join("")
    return `<dl class="facts">${fact("Oracle", o.name)}${fact("Oracle fired", o.passed == null ? null : o.passed ? "Yes" : "No")}${fact("Exchanges", ex.length || null)}</dl>
      ${o.detail ? `<p>${esc(o.detail)}</p>` : ""}
      ${rows ? `<table><thead><tr><th>Step</th><th>Request</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
      ${detail}`
  }
  if (r.proofKind === "evidence") {
    const cited = (Array.isArray(p.cited) ? p.cited : []).map((c) => fact(c.name, cellText(c), true)).join("")
    return `<dl class="facts">${fact("Check", p.check)}${fact("Commit", p.commit, true)}${fact("Snapshot", p.snapshotHash, true)}${cited}</dl>
      ${p.detail ? `<p>${esc(p.detail)}</p>` : ""}`
  }
  return `<p class="muted">The proof record has no known kind. The raw record is below.</p>`
}

// Render the report as one self-contained HTML page. The colours, font and
// mark come from the app's own files (brand.mjs), so the page looks like the
// console. Inline CSS, no script, no remote asset. This is the shareable artifact.
export function renderReportHtml(report) {
  const r = report
  const state = r.proven ? "proven" : "unproven"
  const mark = r.proven
    ? `<span class="mark ok">${ICON.check}Proven</span>`
    : `<span class="mark muted">${ICON.minus}Not reproduced</span>`
  const note = (NOTE[r.proofKind] || NOTE.forge)[state]
  const stages = r.stages || { hypothesis: false, reproduced: false, proven: r.proven }
  const step = (label, done, last = false) =>
    `<li class="${done ? (last ? "ok" : "done") : "todo"}">${done ? ICON.check : ICON.minus}${esc(label)}</li>`
  const ladder = `<ol class="ladder">${step("Hypothesis", stages.hypothesis)}${step("Reproduced", stages.reproduced)}${step("Proven", stages.proven, true)}</ol>`
  const scopeLine = [
    r.scope ? `<span><b>Scope</b> ${esc(r.scope)}</span>` : "",
    r.target ? `<span><b>Target</b> ${esc(r.target)}</span>` : "",
    `<span><b>Run date</b> ${r.runAt ? esc(when(r.runAt)) : "not recorded"}</span>`,
    r.module ? `<span><b>Module</b> ${esc(r.module)}</span>` : "",
  ].filter(Boolean).join("")
  const leadRows = r.leads.length
    ? `<table><thead><tr><th>From</th><th>Check</th><th>Impact</th><th>Where</th></tr></thead><tbody>${r.leads
        .map((l) => `<tr><td>${esc(l.from)}</td><td>${esc(l.check)}</td><td>${esc(l.impact)}</td><td class="mono">${esc(l.where || "")}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">No pre-pass leads were recorded for this finding.</p>`
  const fixBlock = r.fixStated
    ? markdown(r.fix)
    : `<p class="muted">The run did not state a fix. This report does not invent one.</p>`
  const footer = [
    "Touchstone",
    r.runId ? `run ${esc(r.runId)}` : "",
    r.id && r.id !== r.runId ? `finding ${esc(r.id)}` : "",
    r.meta.model ? esc(r.meta.model) : "",
    r.meta.usd != null ? `$${Number(r.meta.usd).toFixed(4)}` : "",
    `generated ${esc(when(r.meta.generatedAt))}`,
  ].filter(Boolean).join(" · ")

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(r.title)} · Touchstone</title>
<style>
${brandCss()}
* { box-sizing: border-box; }
html { font-family: ${FONT_SANS}; -webkit-font-smoothing: antialiased; }
body { margin: 0; background: var(--background); color: var(--foreground); font-size: 14px; line-height: 1.6; }
main { max-width: 46rem; margin: 0 auto; padding: 1.5rem 1.25rem 2rem; }
code, pre, .mono { font-family: ${FONT_MONO}; }
.muted { color: var(--muted-foreground); }
.ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); }

.brand { display: flex; align-items: center; gap: .5rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border); }
.brand .name { font-weight: 600; font-size: 15px; letter-spacing: -.01em; }
.brand .kind { margin-left: auto; font-size: 12px; color: var(--muted-foreground); }
.scope { display: flex; flex-wrap: wrap; gap: .25rem 1.25rem; margin: .875rem 0 1.25rem; font-size: 12px; color: var(--muted-foreground); }
.scope b { font-weight: 500; color: var(--foreground); margin-right: .25rem; }

.card { background: var(--background); border: 1px solid color-mix(in oklab, var(--border) 60%, transparent); border-radius: calc(var(--radius) * 1.4); overflow: hidden; }
@media (prefers-color-scheme: dark) { .card { background: var(--popover); } }
.card > .body { padding: .875rem 1rem; }
.card > .foot { border-top: 1px solid color-mix(in oklab, var(--border) 60%, transparent); padding: .5rem 1rem; }

.overline { display: flex; align-items: center; gap: .5rem; font-size: 11px; font-weight: 500; letter-spacing: .025em; text-transform: uppercase; }
.overline .dot { color: color-mix(in oklab, var(--muted-foreground) 50%, transparent); }
.mark { margin-left: auto; display: inline-flex; align-items: center; gap: .25rem; font-size: 12px; font-weight: 500; text-transform: none; letter-spacing: 0; }
h1 { margin: .375rem 0 0; font-size: 20px; line-height: 1.35; font-weight: 600; letter-spacing: -.01em; text-wrap: pretty; }
.note { margin: .25rem 0 0; font-size: 12px; color: var(--muted-foreground); }
.status { margin: .5rem 0 0; font-size: 13px; }

.ladder { display: flex; flex-wrap: wrap; gap: .25rem 1rem; margin: 0; padding: 0; list-style: none; font-size: 12px; }
.ladder li { display: inline-flex; align-items: center; gap: .25rem; color: var(--muted-foreground); }
.ladder li.done { color: var(--foreground); }
.ladder li.ok { color: var(--ok); font-weight: 500; }
.ladder li.todo { opacity: .6; }

section { margin-top: 1.5rem; }
h2 { margin: 0 0 .5rem; font-size: 11px; font-weight: 500; letter-spacing: .025em; text-transform: uppercase; color: var(--muted-foreground); }
h3 { margin: .875rem 0 .375rem; font-size: 12px; font-weight: 500; color: var(--muted-foreground); }
h4 { margin: 1rem 0 .25rem; font-size: 14px; font-weight: 600; }
p { margin: .5rem 0; }
.body > :first-child, .fold > :first-child { margin-top: 0; }
.body > :last-child, .fold > :last-child { margin-bottom: 0; }
ul, ol { margin: .375rem 0; padding-left: 1.25rem; }
li { margin: .125rem 0; }
.harm li::marker { color: var(--muted-foreground); }
.asserts { list-style: none; padding: 0; }
.asserts code { font-size: 12px; }

.facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); gap: .625rem 1rem; margin: 0; }
.facts dt { font-size: 11px; color: var(--muted-foreground); }
.facts dd { margin: 0; font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.facts dd.mono { font-size: 12px; }

code { font-size: .9em; background: color-mix(in oklab, var(--foreground) 6%, transparent); padding: .05rem .3rem; border-radius: calc(var(--radius) * .6); }
pre.code { margin: .5rem 0; padding: .625rem .75rem; font-size: 11.5px; line-height: 1.55; background: color-mix(in oklab, var(--foreground) 4%, transparent); border-radius: calc(var(--radius) * .8); overflow: auto; white-space: pre; }

table { width: 100%; border-collapse: collapse; margin: .5rem 0; font-size: 12px; }
th { text-align: left; font-weight: 500; color: var(--muted-foreground); }
th, td { padding: .375rem .5rem .375rem 0; border-bottom: 1px solid color-mix(in oklab, var(--border) 60%, transparent); vertical-align: top; }
tr:last-child td { border-bottom: 0; }

details { border-top: 1px solid color-mix(in oklab, var(--border) 60%, transparent); }
.body > details:first-of-type { margin-top: .875rem; }
.card > details:first-child { border-top: 0; }
summary { cursor: pointer; padding: .5rem 0; font-size: 12px; font-weight: 500; color: var(--muted-foreground); list-style: none; }
.card > details > summary { padding: .625rem 1rem; }
summary::-webkit-details-marker { display: none; }
summary::before { content: "›"; display: inline-block; width: 1em; transition: transform .15s; }
details[open] > summary::before { transform: rotate(90deg); }
summary:hover { color: var(--foreground); }
.fold { padding: 0 0 .75rem; }
.card > details > .fold { padding: 0 1rem .875rem; }

footer { margin-top: 2rem; padding-top: .875rem; border-top: 1px solid var(--border); font-size: 11px; color: var(--muted-foreground); display: flex; align-items: center; gap: .375rem; }
footer svg { flex-shrink: 0; }
@media print { details > .fold { display: block; } body { font-size: 12px; } }
</style></head>
<body><main>
<header class="brand">${markSvg(20)}<span class="name">Touchstone</span><span class="kind">Finding report</span></header>
<div class="scope">${scopeLine}</div>

<article class="card">
  <div class="body">
    <div class="overline"><span class="muted">Finding</span><span class="dot">·</span><span class="${sevInk(r)}">${esc(r.severity || "unrated")}</span>${mark}</div>
    <h1>${esc(r.title)}</h1>
    <p class="note">${esc(note)}</p>
    ${r.proven ? "" : `<p class="status">${esc(r.status)}</p>`}
    ${r.dismissed ? `<p class="status muted">The operator dismissed it in the ledger. That is a judgement, not a disproof.</p>` : ""}
  </div>
  <div class="foot">${ladder}</div>
</article>

<section><h2>The proof · ${esc(PROOF_NAME[r.proofKind] || r.proofKind || "unknown")}</h2>
  <div class="card"><div class="body">${proofBody(r)}</div></div>
</section>

<section><h2>The harm</h2>
  <div class="card"><div class="body"><ul class="harm">${r.harm.map((h) => `<li>${esc(h)}</li>`).join("")}</ul></div></div>
</section>

<section><h2>The fix</h2>
  <div class="card"><div class="body">${fixBlock}</div></div>
</section>

<section><h2>Details</h2>
  <div class="card">
    ${r.narrative ? fold("Explanation from the agent", markdown(r.narrative)) : ""}
    ${r.hypothesis ? fold("What the agent read first", `<pre class="code">${esc(r.hypothesis)}</pre>`) : ""}
    ${fold(`Pre-pass leads · ${r.leads.length}`, leadRows)}
    ${fold("Proof record (JSON)", r.proof ? `<pre class="code">${esc(JSON.stringify(r.proof, null, 2))}</pre>` : `<p class="muted">No proof record.</p>`)}
  </div>
</section>

<footer>${markSvg(12)}<span>${footer}</span></footer>
</main></body></html>`
}

// Render the report as Markdown, for a README or an issue.
export function renderReportMarkdown(report) {
  const r = report;
  const out = [];
  out.push(`# ${r.title}`);
  out.push("");
  out.push(`**${r.proven ? "Proven by replay" : "Not proven"}** · severity: ${r.severity || "unrated"} · ${r.module || ""} · target: ${r.target || "—"} · proof: ${r.proofKind || "—"}`);
  out.push("");
  out.push(r.status);
  if (r.hypothesis) { out.push("", "## What we looked at", "", r.hypothesis); }
  if (r.narrative) { out.push("", "## The finding", "", r.narrative); }
  out.push("", "## The harm", "");
  for (const h of r.harm) out.push(`- ${h}`);
  out.push("", "## The fix", "");
  out.push(r.fixStated ? r.fix : "_The run did not state a fix. This report does not invent one._");
  out.push("", "## Where it started (pre-pass leads)", "");
  if (r.leads.length) {
    out.push("| From | Check | Impact | Where |", "|---|---|---|---|");
    for (const l of r.leads) out.push(`| ${l.from} | ${l.check} | ${l.impact} | ${l.where || ""} |`);
  } else {
    out.push("_No pre-pass leads were recorded for this finding._");
  }
  out.push("", "## The proof", "", "```json", JSON.stringify(r.proof ?? null, null, 2), "```");
  out.push("", `---`, `Touchstone report · run ${r.runId || ""} · finding ${r.id || ""} · generated ${new Date(r.meta.generatedAt).toISOString()}`);
  return out.join("\n");
}
