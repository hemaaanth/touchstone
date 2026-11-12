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
//
// Both run through runTool() on the lab's private Docker network.
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool } from "../../lib/wrap.mjs";
import { parseNuclei } from "../web/scan.mjs";

export const IMAGES = {
  inspector: "touchstone/mcp-inspector:0.17.2",
  nuclei: "projectdiscovery/nuclei:v3.4.10",
};
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

// `baseUrl` is the origin on the lab network, e.g. http://lab:8080.
// `token` is the low-privilege bearer token the agent was given.
export async function scanMcp({ net, baseUrl, token, only, run = runTool, timeoutMs = 120_000 } = {}) {
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
  };
  try {
    const done = await Promise.all(Object.keys(jobs).filter(want).map(async (n) => {
      try { return [n, await jobs[n]()]; } catch (e) { return [n, { r: { code: 1, timedOut: false }, leads: [] }]; }
    }));
    const coverage = done.map(([engine, { r, leads }]) => ({
      engine, status: r.code === 0 || leads.length ? "ran" : "unavailable", code: r.code, timedOut: Boolean(r.timedOut), leads: leads.length,
    }));
    return { coverage, leads: mergeLeads(done.flatMap(([, { leads }]) => leads)) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
