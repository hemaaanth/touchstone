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
// SELF-CONTAINED. renderReportHtml returns one HTML string with inline CSS and
// no external asset, so the file opens anywhere and shares cleanly. The three
// builders are pure: buildReport(finding) -> report; the renderers take that
// report. That keeps them unit-testable with a finding object and no server.

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

  return {
    id: finding.id,
    runId: finding.runId,
    title: finding.title || "Untitled finding",
    severity: finding.severity || null,
    module: finding.module || finding.pack || null,
    target: typeof finding.target === "string" ? finding.target : (finding.target?.title || null),
    proofKind: finding.proofKind || null,
    proven,
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
  };
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

function paras(text) {
  return String(text || "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join("\n");
}

// Render the report as one self-contained HTML page: inline CSS, no external
// asset, light and dark friendly. This is the shareable artifact.
export function renderReportHtml(report) {
  const r = report;
  const sevClass = r.severity ? `sev sev-${esc(String(r.severity).toLowerCase())}` : "sev";
  const provenBadge = r.proven
    ? `<span class="badge proven">Proven by replay</span>`
    : `<span class="badge unproven">Not proven</span>`;
  const leadRows = r.leads.length
    ? `<table class="leads"><thead><tr><th>From</th><th>Check</th><th>Impact</th><th>Where</th></tr></thead><tbody>${r.leads
        .map((l) => `<tr><td>${esc(l.from)}</td><td>${esc(l.check)}</td><td>${esc(l.impact)}</td><td>${esc(l.where || "")}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">No pre-pass leads were recorded for this finding.</p>`;
  const fixBlock = r.fixStated
    ? paras(r.fix)
    : `<p class="muted">The run did not state a fix. This report does not invent one.</p>`;
  const proofJson = r.proof ? `<pre class="proof">${esc(JSON.stringify(r.proof, null, 2))}</pre>` : `<p class="muted">No proof record.</p>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.title)} — Touchstone report</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1.25rem; color: #16181d; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e6e7ea; background: #0f1115; } .muted { color: #9aa0aa !important; } pre, table { background: #171a21 !important; border-color: #2a2f3a !important; } th { border-color: #2a2f3a !important; } }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 1.75rem 0 .5rem; border-bottom: 1px solid #e5e7eb; padding-bottom: .25rem; }
  .meta { color: #6b7280; font-size: .85rem; margin: 0 0 1rem; }
  .muted { color: #6b7280; }
  .badge { display: inline-block; font-size: .78rem; padding: .1rem .5rem; border-radius: 999px; font-weight: 600; }
  .badge.proven { background: #dcfce7; color: #166534; }
  .badge.unproven { background: #fef3c7; color: #92400e; }
  .sev { font-weight: 600; text-transform: capitalize; }
  .sev-critical, .sev-high { color: #b91c1c; }
  .sev-medium { color: #b45309; }
  .sev-low, .sev-info { color: #4b5563; }
  ul { margin: .25rem 0; padding-left: 1.25rem; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; background: #fafafa; }
  th, td { text-align: left; padding: .35rem .5rem; border: 1px solid #e5e7eb; }
  pre { background: #f6f7f9; border: 1px solid #e5e7eb; border-radius: 8px; padding: .75rem; overflow: auto; font-size: .82rem; }
  footer { margin-top: 2.5rem; color: #9ca3af; font-size: .8rem; border-top: 1px solid #e5e7eb; padding-top: .75rem; }
</style></head>
<body>
  <h1>${esc(r.title)}</h1>
  <p class="meta">${provenBadge} &nbsp; <span class="${sevClass}">${esc(r.severity || "unrated")}</span> &nbsp;·&nbsp; ${esc(r.module || "")} &nbsp;·&nbsp; target: ${esc(r.target || "—")} &nbsp;·&nbsp; proof: ${esc(r.proofKind || "—")}</p>
  <p>${esc(r.status)}</p>

  ${r.hypothesis ? `<h2>What we looked at</h2>${paras(r.hypothesis)}` : ""}
  ${r.narrative ? `<h2>The finding</h2>${paras(r.narrative)}` : ""}

  <h2>The harm</h2>
  <ul>${r.harm.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>

  <h2>The fix</h2>
  ${fixBlock}

  <h2>Where it started (pre-pass leads)</h2>
  ${leadRows}

  <h2>The proof</h2>
  ${proofJson}

  <footer>
    Touchstone report · run ${esc(r.runId || "")} · finding ${esc(r.id || "")}<br>
    ${r.meta.model ? `model ${esc(r.meta.model)} · ` : ""}${r.meta.usd != null ? `$${Number(r.meta.usd).toFixed(4)} · ` : ""}generated ${new Date(r.meta.generatedAt).toISOString()}
  </footer>
</body></html>`;
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
