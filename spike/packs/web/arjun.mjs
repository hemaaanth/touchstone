// Arjun hidden-parameter discovery for the Web pack's prepass. Arjun does NOT
// discover endpoints; it mines a KNOWN endpoint for UNDOCUMENTED query/body
// parameters by probing many candidate names and watching the response change
// (a reflected value, a different length or status). ffuf finds hidden PATHS;
// Arjun finds hidden PARAMS on paths you already know.
//
// Like scan.mjs and ffuf.mjs, this file never opens a connection of its own. It
// reaches the target through one door: the Docker network `net` and the base
// URL `baseUrl`, the same two values startLab() (or a live scope proxy) gives.
// The image is pinned and built locally (Dockerfile.arjun), and the run uses
// --pull=never, so Arjun only ever talks to the lab, never a registry or PyPI.
//
// An Arjun hit is a LEAD, never a finding. "This endpoint takes an undocumented
// `debug` parameter" is a hint the agent must still prove with a replayed
// request script that an oracle accepts.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool } from "../../lib/wrap.mjs";
import { classifyCode, isTimeout } from "./toolrun.mjs";

// Built by spike/scripts/build-labs.sh from packs/web/Dockerfile.arjun.
export const ARJUN_IMAGE = "touchstone/web-arjun:2.2.7";

// The public, documented endpoints we mine for undocumented parameters. These
// are the routes an operator's brief lists and that answer without a session,
// so an automated prepass can reach them. A bigger target would pass its own
// documented surface here; the point of the tool is unchanged.
export const DEFAULT_ENDPOINTS = ["/healthz", "/"];

const cap = (s, n = 200) => String(s ?? "").slice(0, n);
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return String(u ?? ""); } };

// Parameter names whose mere presence is worth more: a hidden `debug`/`admin`
// flag is a likelier security lead than a hidden display option. Ranking only;
// a lead is still just a lead.
const SENSITIVE_PARAM = /^(debug|admin|internal|test|secret|token|key|raw|unsafe|dev|trace|verbose|disclose|include|_debug)$/i;

// ---- parser: a pure function over Arjun's -oJ JSON. No Docker to test it.
//
// Arjun writes { "<url>": { "method": "...", "params": ["name", ...], ... } }.
// One entry per scanned URL; `params` is the undocumented names it confirmed.
// We keep only the name, path and method -- never a response body, so a value
// the endpoint leaked when probed never rides along into a lead.
export function parseArjun(text) {
  let j;
  try { j = JSON.parse(text); } catch { return []; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return [];
  const out = [];
  const seen = new Set();
  for (const [url, info] of Object.entries(j)) {
    const path = pathOf(url);
    const method = String(info?.method ?? "GET").toUpperCase();
    const params = Array.isArray(info?.params) ? info.params : [];
    for (const raw of params) {
      const param = String(raw ?? "").trim();
      if (!param) continue;
      const key = `${method} ${path} ${param}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sensitive = SENSITIVE_PARAM.test(param);
      out.push({
        engine: "arjun",
        check: "hidden-parameter",
        impact: sensitive ? "Medium" : "Low",
        where: `${method} ${path} ?${param}=`,
        path,
        param,
        method,
        description: cap(`Arjun found an undocumented ${method} parameter "${param}" on ${path}: the endpoint's response changes when it is sent, though no page or openapi.yaml names it. ${sensitive ? "The name suggests a debug/admin flag worth proving." : "Worth checking what it changes."}`, 240),
      });
    }
  }
  return out;
}

// ---- runner

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

// Mine each endpoint in { endpoints } for undocumented parameters. One Arjun
// container per endpoint (Arjun's -u takes a single URL); all join the existing
// lab network, so no new network is created. Always resolves; never throws.
//
// Fails closed per endpoint. Arjun exits 0 when it completes an endpoint, and
// writes its -oJ file ONLY when it confirmed at least one parameter; a clean
// endpoint exits 0 with no file (its stdout says "No parameters were
// discovered"). So:
//   - a timeout (timedOut, or exit 124/143/137) is a GAP for that endpoint;
//   - any other non-zero exit is a GAP for that endpoint;
//   - exit 0 means the endpoint was CHECKED: parse the file if present (a file
//     that does not parse to an object is itself a gap), no file means checked
//     with no parameters.
// Parameters are kept only for the endpoint they were reported on (item 3).
// The tool is "ran" if at least one endpoint was checked, "unavailable" if
// none were; a partial run stays "ran" but carries a reason naming the gaps,
// so a gap is never shown as a clean result (items 3-4).
// Returns { coverage: [one entry], leads } in scanWeb's shape.
export async function scanArjun({ net, baseUrl, endpoints = DEFAULT_ENDPOINTS, run = runTool, timeoutMs = 180_000 } = {}) {
  const leads = [];
  const gaps = [];              // human-readable reason per unchecked endpoint
  let checked = 0;              // endpoints Arjun actually completed
  let lastCode = 0;
  let timedOut = false;
  for (const ep of endpoints) {
    const epPath = ep.startsWith("/") ? ep : `/${ep}`;
    const scratch = mkdtempSync(join(tmpdir(), "web-arjun-"));
    chmodSync(scratch, 0o777);
    try {
      const url = `${baseUrl}${epPath}`;
      const r = await run({
        image: ARJUN_IMAGE, ws: scratch, network: net, timeoutMs,
        cmd: ["arjun", "-u", url, "-oJ", "/work/arjun.json", "-m", "GET", "-t", "10"],
      });
      lastCode = r.code;
      if (isTimeout(r.code, r.timedOut)) {
        timedOut = true;
        gaps.push(`${epPath}: timed out (exit ${r.code})`);
        continue;
      }
      if (classifyCode(r.code) !== "ok") {
        gaps.push(`${epPath}: arjun exited ${r.code} ${cap(r.stderr, 80)}`.trim());
        continue;
      }
      // exit 0 == endpoint checked. A file only appears when params were found.
      const file = join(scratch, "arjun.json");
      if (existsSync(file)) {
        const text = read(file);
        let obj;
        try { obj = JSON.parse(text); } catch { obj = undefined; }
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
          gaps.push(`${epPath}: arjun exited 0 but its report did not parse`);
          continue;
        }
        for (const l of parseArjun(text)) if (l.path === epPath) leads.push(l);
      }
      checked += 1;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const status = checked > 0 ? "ran" : "unavailable";
  const gapNote = gaps.length
    ? ` ${gaps.length} of ${endpoints.length} endpoint(s) not checked: ${cap(gaps.join("; "), 180)}`
    : "";
  const reason = status === "unavailable"
    ? cap(`arjun checked 0 of ${endpoints.length} endpoint(s)${timedOut ? " (timed out)" : ""}.${gapNote}`, 240)
    : gaps.length ? cap(`arjun ran but did not check every endpoint.${gapNote}`, 240) : "";
  return {
    coverage: [{
      engine: "arjun",
      status,
      code: lastCode,
      timedOut,
      leads: leads.length,
      endpoints: endpoints.length,
      checked,
      ...(reason ? { reason } : {}),
    }],
    leads,
  };
}
