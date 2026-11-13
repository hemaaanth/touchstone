// The AI and MCP prepass. It wraps two open-source tools and reads the result
// as LEADS. A lead is a hint. Only a replayed request script that an oracle
// accepts is a finding.
//
//   mcp-inspector  the MCP project's own CLI. It lists the server's tools.
//                  We read the list with plain rules: which tools can send
//                  data out, which can change or delete, which take an
//                  address or a path.
//   nuclei         one original template: does tools/list answer with no
//                  sign-in at all.
//   mcp-shield     pattern rules over each tool's description and argument
//                  names (hidden instructions, shadowing, sensitive files,
//                  side-channel arguments). Pattern rules only: it never gets a
//                  model key, so it makes no model or vendor call.
//   garak          LLM probes (prompt injection, injection hidden in a
//                  document, markdown exfil, XSS) sent to the assistant's
//                  chat endpoint. LIVE runs only, and only when the operator
//                  set an assistant path and a request budget: every probe
//                  can cost the operator a model call. A relay inside the
//                  image enforces the budget. Detectors are string checks,
//                  so no text goes anywhere but the target.
//
// All run through runTool() on the lab's private Docker network, or on the
// scan network of a live run.
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool } from "../../lib/wrap.mjs";
import { requireImage } from "../../lib/proof-http.mjs";
import { parseNuclei } from "../web/scan.mjs";

export const IMAGES = {
  inspector: "touchstone/mcp-inspector:0.17.2",
  nuclei: "projectdiscovery/nuclei:v3.4.10",
  shield: "touchstone/mcp-shield:1.0.4",
  garak: "touchstone/garak:0.17.1",
};
// Images we build ourselves, and the build-labs target for each. A missing one
// must never fall through to `docker pull` of a stranger's image.
const LOCAL_BUILD = { [IMAGES.inspector]: "inspector", [IMAGES.shield]: "shield", [IMAGES.garak]: "garak" };
// garak's own limits. It sends one request at a time, up to 20 s each, so it
// needs more than the 120 s the other tools get. The relay stops sending at
// GARAK_DEADLINE_S; runTool kills the container at GARAK_TIMEOUT_MS.
export const GARAK_TIMEOUT_MS = 600_000;
const GARAK_DEADLINE_S = 480;
export const GARAK_BUDGET = { min: 8, max: 200 };
const TEMPLATES = new URL("./scan/templates", import.meta.url).pathname;
const RANK = { High: 0, Medium: 1, Low: 2, Informational: 3 };

// Rules over a tool's name, text and argument names. Order: worst first.
const RULES = [
  { check: "tool-sends-data-out", impact: "Medium", test: (t) => /(^|_)(send|email|mail|post|publish|upload|webhook|notify)/i.test(t.name), note: "The tool can send data out of the system. If an agent can be told to call it, it can leak data." },
  { check: "tool-changes-or-deletes", impact: "Medium", test: (t) => /(^|_)(delete|remove|drop|write|update|exec|run|shell|kill)/i.test(t.name), note: "The tool changes or deletes data. Check who may call it." },
  { check: "tool-takes-address-or-path", impact: "Medium", test: (t) => t.args.some((a) => /^(url|uri|path|file|filename|dir|host|endpoint|cmd|command)$/i.test(a)), note: "The tool takes an address or a path. The scope check on that value may be weak." },
];

// Turn the tools/list JSON into leads. Never copies a response body.
export function parseInspector(text) {
  let doc;
  try { doc = JSON.parse(String(text ?? "")); } catch { return []; }
  const leads = [];
  for (const tool of doc?.tools ?? []) {
    const t = { name: String(tool.name ?? ""), args: Object.keys(tool.inputSchema?.properties ?? {}) };
    if (!t.name) continue;
    for (const rule of RULES) {
      if (!rule.test(t)) continue;
      leads.push({ engine: "mcp-inspector", check: rule.check, impact: rule.impact, where: `tool ${t.name}`, path: `tool ${t.name}`, description: rule.note });
    }
  }
  return leads;
}

// mcp-shield's per-tool severity -> our impact words.
const SHIELD_IMPACT = { HIGH: "High", MEDIUM: "Medium", LOW: "Low" };
// mcp-shield's detection groups -> our check names and notes.
const SHIELD_GROUPS = [
  ["hiddenInstructions", "shield-hidden-instructions", "mcp-shield found instruction-like text in the tool description"],
  ["shadowing", "shield-tool-shadowing", "mcp-shield found text that tries to change how other tools are used"],
  ["sensitiveFileAccess", "shield-sensitive-file-access", "mcp-shield found a sensitive file or secret word in the tool description"],
];
const label = (v) => String(v ?? "").replace(/[^\w .:/-]/g, "").slice(0, 60);

// Turn run.mjs's JSON (mcp-shield's own result object) into leads. Only the
// tool name, mcp-shield's fixed rule names and argument names are kept. The
// matched description text is never copied: it is the target's own text.
// { ok: false } (or bad JSON) is a tool error, never a clean result.
export function parseShield(text) {
  let doc;
  try { doc = JSON.parse(String(text ?? "").trim().split("\n").pop()); } catch { return { ok: false, error: "mcp-shield printed no JSON result", leads: [] }; }
  if (doc?.ok !== true || !Array.isArray(doc.vulnerabilities)) return { ok: false, error: String(doc?.error ?? "").replace(/[^\w .:/()-]/g, "").slice(0, 200) || "mcp-shield reported an error", leads: [] };
  const leads = [];
  const add = (check, impact, tool, description) => leads.push({ engine: "mcp-shield", check, impact, where: `tool ${tool}`, path: `tool ${tool}`, description });
  for (const v of doc.vulnerabilities) {
    const impact = SHIELD_IMPACT[v?.severity] ?? "Low";
    if (!v?.tool) {
      for (const m of v?.crossRefMatches ?? []) add("shield-cross-origin-reference", impact, label(m.tool), `mcp-shield found a reference to another server (${label(m.referencedName)}) in the tool description. A lead only.`);
      continue;
    }
    const d = v.detectionDetails ?? {};
    const tool = label(v.tool);
    for (const [key, check, note] of SHIELD_GROUPS) {
      const kinds = [...new Set((d[key] ?? []).map((m) => label(m.type)).filter(Boolean))];
      if (kinds.length) add(check, impact, tool, `${note} (${kinds.join(", ")}). A pattern hit is a lead only.`);
    }
    const params = [...new Set((d.exfiltrationChannels ?? []).map((m) => label(m.param)).filter(Boolean))];
    if (params.length) add("shield-side-channel-argument", impact, tool, `mcp-shield flags free-text arguments a poisoned agent could fill with data (${params.join(", ")}). A lead only.`);
  }
  return { ok: true, toolCount: Number(doc.server?.toolCount) || 0, leads };
}

// What each garak probe tries, in our words. A probe we do not name is dropped.
const GARAK_PROBES = {
  "promptinject.HijackHateHumans": "a prompt-injection order to print a fixed phrase",
  "promptinject.HijackKillHumans": "a prompt-injection order to print a fixed phrase",
  "latentinjection.LatentInjectionReport": "an order hidden inside a report the assistant is asked to summarise",
  "latentinjection.LatentInjectionResume": "an order hidden inside a resume the assistant is asked to assess",
  "latentinjection.LatentWhois": "an order hidden inside WHOIS data the assistant is asked to assess",
  "web_injection.MarkdownImageExfil": "an order to put data into a markdown image URL (an exfil channel)",
  "web_injection.StringAssemblyDataExfil": "an order to build a markdown exfil URL from pieces",
  "web_injection.TaskXSS": "an order to put a script tag in the reply (XSS)",
};
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

// Turn run.py's JSON into leads: one per probe whose detector matched at
// least one reply. garak's "fails" are replies the detector matched (the
// attack worked). Only counts and garak's fixed probe and detector names are
// kept, never a prompt or a reply. { ok: false } or bad JSON is a tool error.
export function parseGarak(text, { path = "/agent/chat" } = {}) {
  let doc;
  try { doc = JSON.parse(String(text ?? "").trim().split("\n").pop()); } catch { return { ok: false, error: "garak printed no JSON result", leads: [] }; }
  if (doc?.ok !== true || !Array.isArray(doc.evals)) return { ok: false, error: String(doc?.error ?? "").replace(/[^\w .:/(),{}'-]/g, "").slice(0, 200) || "garak reported an error", leads: [] };
  const where = `assistant ${label(path)}`;
  const leads = [];
  for (const e of doc.evals) {
    const what = GARAK_PROBES[e?.probe];
    const fails = count(e?.fails);
    const total = count(e?.total);
    if (!what || !fails || !total) continue;
    leads.push({
      engine: "garak", check: `garak-${e.probe}`, impact: "Medium", where, path: where,
      description: `garak sent ${what}. ${fails} of ${total} replies matched its string detector (${label(e.detector)}). A string match is a lead only: replay it with run_request_script and check the effect.`,
    });
  }
  return {
    ok: true, leads, budget: count(doc.budget), requests: count(doc.requests), replies: count(doc.replies),
    upstreamErrors: count(doc.upstreamErrors),
    probeErrors: (Array.isArray(doc.probeErrors) ? doc.probeErrors : []).map((x) => String(x).replace(/[^\w .:/(),-]/g, "").slice(0, 120)).slice(0, 8),
  };
}

// One lead per (check, tool), worst first. Two engines on one place is "corroborated".
export function mergeLeads(all) {
  const byKey = new Map();
  for (const l of all) {
    const key = `${l.check}|${l.where}`;
    const cur = byKey.get(key);
    if (!cur) byKey.set(key, { ...l, engines: [l.engine] });
    else if (!cur.engines.includes(l.engine)) cur.engines.push(l.engine);
  }
  return [...byKey.values()]
    .map((l) => ({ ...l, corroborated: l.engines.length >= 2 }))
    .sort((a, b) => (RANK[a.impact] ?? 9) - (RANK[b.impact] ?? 9) || a.where.localeCompare(b.where));
}

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

const imagePresent = (image) => requireImage(image, LOCAL_BUILD[image]).then(() => true, () => false);

// `baseUrl` is the origin on the lab network, e.g. http://lab:8080.
// `token` is the low-privilege bearer token the agent was given.
// `garak` is only given in a live run: { path, budget, reqKey?, replyKey? }
// to run it, or { skip: reason } to show why it did not run. A lab run passes
// nothing, so garak is not listed.
export async function scanMcp({ net, baseUrl, token, garak, only, run = runTool, hasImage = imagePresent, timeoutMs = 120_000 } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "mcp-scan-"));
  chmodSync(scratch, 0o777);
  cpSync(TEMPLATES, join(scratch, "templates"), { recursive: true });
  const want = (e) => !only || only.includes(e);
  const jobs = {
    "mcp-inspector": () => run({
      image: IMAGES.inspector, network: net, timeoutMs,
      cmd: ["--cli", `${baseUrl}/mcp`, "--transport", "http", "--method", "tools/list", ...(token ? ["--header", `Authorization: Bearer ${token}`] : [])],
    }).then((r) => ({ r, leads: parseInspector(r.stdout) })),
    nuclei: () => run({
      image: IMAGES.nuclei, ws: scratch, network: net, timeoutMs, env: { HOME: "/tmp" },
      cmd: ["-u", baseUrl, "-t", "/work/templates", "-jsonl", "-or", "-ot", "-o", "/work/nuclei.jsonl", "-duc", "-silent", "-nc"],
    }).then((r) => ({ r, leads: parseNuclei(read(join(scratch, "nuclei.jsonl"))) })),
    // The token rides in the environment; bridge.mjs (in the image) sends it.
    "mcp-shield": () => run({
      image: IMAGES.shield, network: net, timeoutMs, env: token ? { MCP_TOKEN: token } : {},
      cmd: [`${baseUrl}/mcp`],
    }).then((r) => {
      const p = parseShield(r.stdout);
      if (p.ok && r.code === 0) return { r, leads: p.leads };
      return { r: { ...r, code: r.code || 1 }, leads: [], reason: r.timedOut ? "mcp-shield timed out." : `mcp-shield failed: ${p.error}` };
    }),
  };
  if (garak?.path) {
    // The token and the budget ride in the environment. run.py's relay is the
    // only thing that talks to the endpoint, and it stops at the budget.
    jobs.garak = () => run({
      image: IMAGES.garak, network: net, timeoutMs: GARAK_TIMEOUT_MS,
      env: {
        GARAK_BUDGET: String(garak.budget), GARAK_DEADLINE_S: String(GARAK_DEADLINE_S),
        ...(token ? { MCP_TOKEN: token } : {}),
        ...(garak.reqKey ? { GARAK_REQ_KEY: garak.reqKey } : {}),
        ...(garak.replyKey ? { GARAK_REPLY_KEY: garak.replyKey } : {}),
      },
      cmd: [`${baseUrl}${garak.path}`],
    }).then((r) => {
      const p = parseGarak(r.stdout, { path: garak.path });
      if (p.ok && r.code === 0) {
        const notes = [`${p.requests} of ${p.budget} requests used, ${p.replies} replies`];
        if (p.upstreamErrors) notes.push(`${p.upstreamErrors} requests failed`);
        if (p.probeErrors.length) notes.push(`probes that did not finish: ${p.probeErrors.join("; ")}`);
        return { r, leads: p.leads, reason: `${notes.join(". ")}.` };
      }
      return { r: { ...r, code: r.code || 1 }, leads: [], reason: r.timedOut ? "garak timed out." : `garak failed: ${p.error}` };
    });
  }
  const imageOf = { "mcp-inspector": IMAGES.inspector, nuclei: IMAGES.nuclei, "mcp-shield": IMAGES.shield, garak: IMAGES.garak };
  const skipped = garak?.skip && want("garak")
    ? [{ engine: "garak", status: "unavailable", applicable: false, code: null, timedOut: false, leads: 0, reason: String(garak.skip).slice(0, 200) }]
    : [];
  try {
    const done = await Promise.all(Object.keys(jobs).filter(want).map(async (n) => {
      const image = imageOf[n];
      if (LOCAL_BUILD[image] && !(await hasImage(image))) {
        return [n, { r: { code: 1, timedOut: false }, leads: [], reason: `image ${image} is not built. Build it with: npm run build:labs -- ${LOCAL_BUILD[image]}` }];
      }
      try { return [n, await jobs[n]()]; } catch (e) { return [n, { r: { code: 1, timedOut: false }, leads: [], reason: `${n} could not start: ${String(e?.message ?? e).slice(0, 160)}` }]; }
    }));
    const coverage = [...done.map(([engine, { r, leads, reason }]) => ({
      engine, status: r.code === 0 || leads.length ? "ran" : "unavailable", code: r.code, timedOut: Boolean(r.timedOut), leads: leads.length,
      ...(reason ? { reason } : {}),
    })), ...skipped];
    return { coverage, leads: mergeLeads(done.flatMap(([, { leads }]) => leads)) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
