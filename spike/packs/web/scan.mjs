// The Web pack's prepass scan: three open-source tools run in Docker through
// runTool(), and their output becomes LEADS. A lead is never a finding. Only a
// replayed request script that the oracle accepts is a finding.
//
//   zap     ZAP baseline (passive). Headers, cookies, info leaks. Needs /zap/wrk.
//   nuclei  Template scan. We ship our own templates, so it runs with no internet.
//   dalfox  Reflected XSS scanner. Aimed at URLs that carry a query string.
//
// The scan reaches the target by one door: the Docker network `net` and the base
// URL `baseUrl`. For the lab these come from startLab(). For a granted live
// target the platform scope proxy supplies the same two values. This file never
// opens a connection of its own.
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool } from "../../lib/wrap.mjs";

export const IMAGES = {
  zap: "ghcr.io/zaproxy/zaproxy:2.16.1",
  nuclei: "projectdiscovery/nuclei:v3.4.10",
  dalfox: "hahwul/dalfox:v2.12.0",
};

const TEMPLATES = new URL("./scan/templates", import.meta.url).pathname;
const RANK = { High: 0, Medium: 1, Low: 2, Informational: 3 };
const cap = (s, n = 200) => String(s ?? "").slice(0, n);
const pathOf = (u) => { try { const x = new URL(u); return x.pathname; } catch { return String(u ?? ""); } };

// ---- parsers: pure functions over tool output. No Docker needed to test them.

// dalfox writes a JSON array. A trailing {} entry is normal. Many payloads hit
// the same URL, so we keep ONE lead per path: the verified
// ("V") hit wins over a reflected ("R") one.
export function parseDalfox(text) {
  let rows;
  try { rows = JSON.parse(text); } catch { return []; }
  const byKey = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.type || !r.data) continue;
    const path = pathOf(r.data);
    const key = path;
    const verified = r.type === "V";
    const prev = byKey.get(key);
    const param = r.param || prev?.lead.param || "(query)";
    // Keep the worst hit, but remember the first real parameter name.
    if (prev && (prev.verified || !verified)) { if (prev.lead.param === "(query)" && r.param) { prev.lead.param = r.param; prev.lead.where = `${path} param ${r.param}`; } continue; }
    byKey.set(key, {
      verified,
      lead: {
        engine: "dalfox",
        check: "reflected-xss",
        impact: verified ? "High" : "Medium",
        where: `${path} param ${param}`,
        path, param,
        description: cap(`${verified ? "Payload ran in the DOM" : "Payload was reflected"} (${r.inject_type}). Payload: ${r.payload}`, 240),
      },
    });
  }
  return [...byKey.values()].map((v) => v.lead);
}

// nuclei -jsonl: one JSON object per line. We never copy the response body: it
// can carry a secret. The extractor names the field only.
export function parseNuclei(text) {
  const leads = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r["template-id"]) continue;
    const sev = String(r.info?.severity ?? "info").toLowerCase();
    const impact = { critical: "High", high: "High", medium: "Medium", low: "Low" }[sev] ?? "Informational";
    const fields = (r["extracted-results"] ?? []).join(", ");
    leads.push({
      engine: "nuclei",
      check: String(r["template-id"]).replace(/^touchstone-/, ""),
      impact,
      where: pathOf(r["matched-at"]),
      path: pathOf(r["matched-at"]),
      description: cap(`${r.info?.name ?? r["template-id"]}${fields ? ` (fields: ${fields})` : ""}. ${r.info?.description ?? ""}`, 240),
    });
  }
  return leads;
}

// ZAP JSON report -> one lead per alert. riskcode: 3 High, 2 Medium, 1 Low, 0 Info.
export function parseZap(text) {
  let j; try { j = JSON.parse(text); } catch { return []; }
  const leads = [];
  for (const site of j?.site ?? []) {
    for (const a of site.alerts ?? []) {
      const first = a.instances?.[0];
      const path = first ? pathOf(first.uri) : "/";
      const more = (a.instances?.length ?? 0) > 1 ? ` (+${a.instances.length - 1} more)` : "";
      leads.push({
        engine: "zap",
        check: cap(a.name, 100),
        impact: ["Informational", "Low", "Medium", "High"][Number(a.riskcode)] ?? "Informational",
        where: `${path}${more}`,
        path,
        rule: String(a.pluginid ?? ""),
        cwe: a.cweid && a.cweid !== "-1" ? String(a.cweid) : null,
        description: cap(`ZAP rule ${a.pluginid}${a.cweid && a.cweid !== "-1" ? `, CWE-${a.cweid}` : ""}. ${first?.param ? `Parameter: ${first.param}.` : ""}`, 240),
      });
    }
  }
  return leads;
}

// Every URL with a query string that ZAP's spider saw. dalfox needs these: a
// scanner cannot guess which URLs take input.
export function zapQueryUrls(text) {
  let j; try { j = JSON.parse(text); } catch { return []; }
  const out = new Set();
  for (const site of j?.site ?? []) for (const a of site.alerts ?? []) for (const i of a.instances ?? []) if (String(i.uri).includes("?")) out.add(i.uri);
  return [...out];
}

// Input URLs the operator already documents: every `/path?query` in a text (the
// brief, the OpenAPI file). They are absolute against baseUrl. dalfox is fed
// these as well as the URLs ZAP's spider finds, because a scanner cannot guess
// which URLs take input.
export function docQueryUrls(text, baseUrl) {
  const out = new Set();
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  for (const m of String(text ?? "").matchAll(/(?<![\w:/.])(\/[A-Za-z0-9_./~-]*\?[A-Za-z0-9_.~%=&+-]+=[A-Za-z0-9_.~%=&+<>-]*)/g)) {
    out.add(`${base}${m[1].replace(/[<>].*$/, "x").replace(/[.,;]+$/, "").replace(/=(?=&|$)/g, "=x")}`);
  }
  return [...out];
}

// One list, worst first. A path that two tools flag gets corroborated=true.
export function mergeLeads(all) {
  const byKey = new Map();
  for (const l of all) {
    const key = `${l.path}|${l.check === "reflected-xss" ? "xss" : l.engine === "zap" ? `zap:${l.check}` : l.check}`;
    const prev = byKey.get(key);
    if (prev) { prev.engines = [...new Set([...prev.engines, l.engine])]; prev.corroborated = prev.engines.length > 1; continue; }
    byKey.set(key, { ...l, engines: [l.engine], corroborated: false });
  }
  const pathEngines = new Map();
  for (const l of byKey.values()) {
    const s = pathEngines.get(l.path) ?? new Set();
    l.engines.forEach((e) => s.add(e));
    pathEngines.set(l.path, s);
  }
  // The same URL path flagged by two different engines is also a corroboration.
  for (const l of byKey.values()) if ((pathEngines.get(l.path)?.size ?? 0) > 1 && l.impact !== "Informational") l.corroborated = true;
  return [...byKey.values()].sort((a, b) => (RANK[a.impact] ?? 9) - (RANK[b.impact] ?? 9));
}

// ---- runners

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

// Run the three tools against { net, baseUrl }. Always resolves. A tool that
// fails is reported as unavailable with its exit code: it never aborts the scan.
//   urls    extra URLs with a query string for dalfox (the spider cannot guess forms)
//   only    run just these engines, e.g. ["nuclei"]
export async function scanWeb({ net, baseUrl, urls = [], only, run = runTool, timeoutMs = 240_000 } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "web-scan-"));
  // ZAP runs as its own image user (uid 1000), so the scratch dir must be writable by it.
  chmodSync(scratch, 0o777);
  cpSync(TEMPLATES, join(scratch, "templates"), { recursive: true });
  const want = (e) => !only || only.includes(e);

  const jobs = {
    zap: () => run({
      image: IMAGES.zap, ws: scratch, network: net, user: "1000:1000", timeoutMs, env: { HOME: "/tmp" },
      cmd: ["bash", "-c", `ln -s /work /zap/wrk && zap-baseline.py -t ${baseUrl}/ -J zap.json -I -m 1`],
    }).then((r) => ({ r, leads: parseZap(read(join(scratch, "zap.json"))) })),
    nuclei: () => run({
      image: IMAGES.nuclei, ws: scratch, network: net, timeoutMs, env: { HOME: "/tmp" },
      cmd: ["-u", baseUrl, "-t", "/work/templates", "-jsonl", "-or", "-ot", "-o", "/work/nuclei.jsonl", "-duc", "-silent", "-nc"],
    }).then((r) => ({ r, leads: parseNuclei(read(join(scratch, "nuclei.jsonl"))) })),
    dalfox: async () => {
      // dalfox waits for ZAP: the spider finds the URLs that take input.
      if (zapRun) await zapRun.catch(() => {});
      const dalfoxUrls = [...new Set([...urls, ...zapQueryUrls(read(join(scratch, "zap.json")))])].slice(0, 5);
      const all = [];
      let last = { code: 0, timedOut: false };
      // dalfox only tests URLs that take input. With none, it did not run: that
      // is NOT the same as "ran and found nothing", and the agent must know.
      if (dalfoxUrls.length === 0) return { r: last, leads: all, noInput: true };
      for (const [i, u] of dalfoxUrls.entries()) {
        const out = `dalfox-${i}.json`;
        last = await run({
          image: IMAGES.dalfox, ws: scratch, network: net, timeoutMs,
          cmd: ["/app/dalfox", "url", u, "--silence", "--format", "json", "--output", `/work/${out}`, "--timeout", "10", "--worker", "20"],
        });
        all.push(...parseDalfox(read(join(scratch, out))));
        if (last.code !== 0) break;
      }
      return { r: last, leads: all };
    },
  };

  let zapRun = null;
  try {
    const names = Object.keys(jobs).filter(want);
    if (want("zap")) zapRun = jobs.zap().catch(() => null);
    const done = await Promise.all(names.map(async (n) => {
      try { return [n, n === "zap" ? ((await zapRun) ?? { r: { code: 1, timedOut: false }, leads: [] }) : await jobs[n]()]; } catch (e) { return [n, { r: { code: 1, timedOut: false, stderr: String(e) }, leads: [] }]; }
    }));
    const coverage = done.map(([engine, { r, leads, noInput }]) => ({
      engine,
      status: noInput ? "no-input" : r.code === 0 || leads.length ? "ran" : "unavailable",
      ...(noInput ? { reason: "No URL with a query string was known (none in the brief or the OpenAPI file, none found by ZAP's spider), so dalfox had nothing to test. This is not a clean result." } : {}),
      code: r.code,
      timedOut: Boolean(r.timedOut),
      leads: leads.length,
    }));
    // ZAP exits 0 or 2 on warnings; -I makes it 0. Treat output as the truth.
    const leads = mergeLeads(done.flatMap(([, { leads }]) => leads));
    return { coverage, leads };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
