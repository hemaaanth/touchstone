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
// lab network, so no new network is created. Always resolves. A run that fails
// is reported, and only a run that produced no usable result at all makes the
// tool "unavailable" -- never a clean "found nothing" from a broken run.
// Returns { coverage: [one entry], leads } in scanWeb's shape.
export async function scanArjun({ net, baseUrl, endpoints = DEFAULT_ENDPOINTS, run = runTool, timeoutMs = 180_000 } = {}) {
  const leads = [];
  let anyRan = false;
  let lastCode = 0;
  let lastErr = "";
  let timedOut = false;
  for (const ep of endpoints) {
    const scratch = mkdtempSync(join(tmpdir(), "web-arjun-"));
    chmodSync(scratch, 0o777);
    try {
      const url = `${baseUrl}${ep.startsWith("/") ? ep : `/${ep}`}`;
      const r = await run({
        image: ARJUN_IMAGE, ws: scratch, network: net, pull: "never", timeoutMs,
        cmd: ["arjun", "-u", url, "-oJ", "/work/arjun.json", "-m", "GET", "-t", "10"],
      });
      const got = parseArjun(read(join(scratch, "arjun.json")));
      for (const l of got) leads.push(l);
      // Arjun exits 0 on a clean scan. A 0 exit, or any parsed lead, means the
      // run reached the target and did its job.
      if (r.code === 0 || got.length) anyRan = true;
      lastCode = r.code;
      timedOut = timedOut || Boolean(r.timedOut);
      if (r.code !== 0) lastErr = cap(r.stderr, 160);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const status = anyRan ? "ran" : "unavailable";
  return {
    coverage: [{
      engine: "arjun",
      status,
      code: lastCode,
      timedOut,
      leads: leads.length,
      endpoints: endpoints.length,
      ...(status === "unavailable"
        ? { reason: `arjun exited ${lastCode}${timedOut ? " (timed out)" : ""} with no parsable results across ${endpoints.length} endpoint(s). ${lastErr}` }
        : {}),
    }],
    leads,
  };
}
