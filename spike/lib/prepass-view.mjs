// Read a pack's prepass record without caring which pack made it.
//
// Every pack's prepass hook returns a `record` the run keeps as `prepass`. The
// shapes differ:
//   Contracts      { static: { tool, engines, suspects, top[] },
//                    fuzz:   { tool, engines, applicable, suspects, top[] } }
//   supply chain   { coverage: [{ engine, status, code, timedOut, leads }],
//                    leads: [{ check, impact, where, file, lines, description, engine }] }
//   Keys, Chain watch { mode, block, suspects, corroborated, top: [{ check, impact, where }] }
//   Domains, Surface { pack, leads: [{ engine, check, impact, where, description }] }
//   any other pack the same coverage / leads keys, or `tools` instead of `coverage`
// prepassView turns each of them into one shape for the run view:
//   { total, tools: [{ name, status: "ran" | "unavailable", reason, leads }],
//     leads: [{ check, impact, where, rule, detail, tools[], corroborated }] }
// `rule` is the scanner's rule id and CWE ("10038 · CWE-693"), or "".
// Leads are worst first. A lead is never a finding: only a replay proves one.
// Pack data is untrusted: sizes are capped and no secret value is ever copied
// (only fields we name are read, and a secret lead field is never one of them).

const MAX_LEADS = 50;
const MAX_TOOLS = 20;

const str = (v, max = 200) => (v == null ? "" : String(v).slice(0, max));
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);

const RANK = { critical: 0, high: 1, medium: 2, moderate: 2, low: 3, info: 4, informational: 4 };
const rank = (impact) => RANK[String(impact ?? "").toLowerCase()] ?? 5;

// A place in the target: "Vault.withdraw", "src/app.js:12", or a { file, line } object.
function where(w, line) {
  if (typeof w === "string") return str(line != null && !w.includes(":") ? `${w}:${line}` : w, 160);
  const o = obj(w);
  const file = o.file ?? o.path ?? o.url ?? o.host ?? o.name;
  if (file == null) return line != null ? `line ${str(line, 10)}` : "";
  const ln = o.line ?? line;
  return str(ln != null ? `${file}:${ln}` : file, 160);
}

function statusOf(t) {
  const s = String(t.status ?? "").toLowerCase();
  if (t.applicable === false) return { status: "unavailable", reason: str(t.reason) || "Does not apply to this target." };
  if (s === "timed-out") return { status: "ran", reason: "Stopped at the time cap; the leads it found before that are kept." };
  if (s === "" || s === "ok" || s === "ran" || s === "done" || s === "pass") return { status: "ran", reason: null };
  const reason = str(t.reason)
    || (t.timedOut ? "Timed out." : t.code != null && t.code !== 0 ? `Exited with code ${str(t.code, 10)}.` : "")
    || (s === "unavailable" ? "Not available." : "The tool failed.");
  return { status: "unavailable", reason };
}

function tool(t, name, leads) {
  return { name: str(name, 60) || "tool", ...statusOf(t), leads };
}

// Older ZAP leads keep the rule id and CWE only at the start of their
// description: "ZAP rule 10038, CWE-693. Parameter: q."
const ZAP_PREFIX = /^ZAP rule (\d+)(?:, CWE-(\d+))?\.\s*/;

// The rule id and CWE of a lead, from named fields only. `rule` is the rule
// id only when the lead also has a check; alone it is the check itself.
function ruleOf(o, detail) {
  const id = o.ruleId ?? o.pluginid ?? (o.check != null ? o.rule : null);
  const cwe = o.cwe ?? o.cweid;
  const parts = [];
  if (id != null && String(id) !== "") parts.push(str(id, 60));
  if (cwe != null && String(cwe) !== "" && String(cwe) !== "-1") parts.push(`CWE-${str(cwe, 10).replace(/^CWE-/i, "")}`);
  const m = ZAP_PREFIX.exec(detail);
  const rest = m ? detail.slice(m[0].length) : detail;
  if (parts.length) return { rule: parts.join(" · "), detail: rest };
  if (!m) return { rule: "", detail };
  return { rule: m[2] ? `${m[1]} · CWE-${m[2]}` : m[1], detail: rest };
}

function lead(l, toolNames) {
  const o = obj(l);
  const names = arr(o.engines).map((e) => str(e, 60)).filter(Boolean);
  if (!names.length) names.push(str(o.engine ?? o.tool ?? toolNames, 60));
  const { rule, detail } = ruleOf(o, str(o.property ?? o.description ?? o.detail ?? o.summary, 240));
  return {
    check: str(o.check ?? o.rule ?? o.title, 120),
    impact: str(o.impact ?? o.severity, 20),
    where: where(o.where ?? o.file, o.lines?.[0] ?? o.line),
    rule,
    detail,
    tools: names.filter(Boolean),
    corroborated: Boolean(o.corroborated),
  };
}

// A Contracts record: the static and fuzz phases, each with a ranked top list.
function contracts(rec) {
  const tools = [];
  const leads = [];
  for (const [key, label] of [["static", "Static scan"], ["fuzz", "Fuzzing"]]) {
    const p = rec[key];
    if (!p || typeof p !== "object") continue;
    const engines = arr(p.engines).map((e) => str(e, 40)).filter(Boolean);
    const name = engines.length ? engines.join(" + ") : str(p.tool, 40) || label;
    tools.push(tool(p, name, Number(p.suspects) || 0));
    for (const s of arr(p.top)) leads.push(lead(s, name));
  }
  return { tools, leads };
}

export function prepassView(record) {
  const rec = obj(record);
  if (!Object.keys(rec).length) return null;

  let tools;
  let leads;
  if (rec.static || rec.fuzz) {
    ({ tools, leads } = contracts(rec));
  } else if (Array.isArray(rec.top) && !rec.leads && !rec.coverage && !rec.tools) {
    // One world scan with a ranked top list (the chain packs).
    const name = str(rec.mode ?? rec.pack, 60) || "scan";
    tools = [tool(rec, name, Number(rec.suspects) || rec.top.length)];
    leads = rec.top.map((l) => lead(l, name));
  } else {
    const list = arr(rec.leads);
    const cov = arr(rec.coverage ?? rec.tools).map(obj);
    tools = cov.slice(0, MAX_TOOLS).map((t) => tool(t, t.engine ?? t.name ?? t.tool, Number(t.leads ?? t.count) || 0));
    // No coverage list: name the tools from the leads that came back.
    if (!tools.length && list.length) {
      const counts = new Map();
      for (const l of list) {
        const n = str(obj(l).engine ?? obj(l).tool, 60) || "tool";
        counts.set(n, (counts.get(n) ?? 0) + 1);
      }
      tools = [...counts].map(([name, n]) => ({ name, status: "ran", reason: null, leads: n }));
    }
    leads = list.map((l) => lead(l, ""));
  }
  if (!tools.length && !leads.length) return null;

  // Worst first. The sort is stable, so equal impacts keep the pack's order.
  const sorted = leads
    .map((l, i) => ({ l, i }))
    .sort((a, b) => rank(a.l.impact) - rank(b.l.impact) || Number(b.l.corroborated) - Number(a.l.corroborated) || a.i - b.i)
    .map((x) => x.l);
  // The count a tool reported can be larger than the leads we kept (Contracts keeps a top list).
  const total = Math.max(leads.length, tools.reduce((n, t) => n + t.leads, 0));
  return { total, tools: tools.slice(0, MAX_TOOLS), leads: sorted.slice(0, MAX_LEADS) };
}

// A CLI record (agent-run.mjs) spreads the prepass record into the top level of
// the result instead of keeping it as `prepass`. Pick the prepass fields back out
// by name, so old CLI records show the same fold as app records. Only the keys
// prepassView reads are taken; the rest of the result is never touched.
export function prepassFromResult(r) {
  const res = obj(r);
  if (res.prepass) return res.prepass;
  if (res.static || res.fuzz) return { static: res.static, fuzz: res.fuzz };
  const out = {};
  for (const k of ["coverage", "tools", "leads", "mode", "pack", "suspects", "top"]) if (res[k] != null) out[k] = res[k];
  // `top` alone is the chain packs' shape; a result with only `pack` is not a prepass.
  return out.coverage || out.tools || out.leads || out.top ? out : null;
}

// What the run view shows when a pack's prepass threw. The error text can hold a
// secret (a scanner's output), so it is never copied.
export const prepassFailed = () => ({ total: 0, tools: [], leads: [], failed: true });
