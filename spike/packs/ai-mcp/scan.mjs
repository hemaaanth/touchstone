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
//
// All run through runTool() on the lab's private Docker network.
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
};
// Images we build ourselves, and the build-labs target for each. A missing one
// must never fall through to `docker pull` of a stranger's image.
const LOCAL_BUILD = { [IMAGES.inspector]: "inspector", [IMAGES.shield]: "shield" };
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
export async function scanMcp({ net, baseUrl, token, only, run = runTool, hasImage = imagePresent, timeoutMs = 120_000 } = {}) {
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
  const imageOf = { "mcp-inspector": IMAGES.inspector, nuclei: IMAGES.nuclei, "mcp-shield": IMAGES.shield };
  try {
    const done = await Promise.all(Object.keys(jobs).filter(want).map(async (n) => {
      const image = imageOf[n];
      if (LOCAL_BUILD[image] && !(await hasImage(image))) {
        return [n, { r: { code: 1, timedOut: false }, leads: [], reason: `image ${image} is not built. Build it with: npm run build:labs -- ${LOCAL_BUILD[image]}` }];
      }
      try { return [n, await jobs[n]()]; } catch (e) { return [n, { r: { code: 1, timedOut: false }, leads: [], reason: `${n} could not start: ${String(e?.message ?? e).slice(0, 160)}` }]; }
    }));
    const coverage = done.map(([engine, { r, leads, reason }]) => ({
      engine, status: r.code === 0 || leads.length ? "ran" : "unavailable", code: r.code, timedOut: Boolean(r.timedOut), leads: leads.length,
      ...(reason ? { reason } : {}),
    }));
    return { coverage, leads: mergeLeads(done.flatMap(([, { leads }]) => leads)) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
