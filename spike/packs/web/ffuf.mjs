// ffuf content discovery for the Web pack's prepass. ffuf brute-forces a path
// wordlist against the target and reports which paths answer. The three
// scanners in scan.mjs (zap spider, nuclei templates, dalfox) only reach paths
// that are linked, templated or take a query; an unlinked, undocumented route
// is invisible to them. ffuf guesses paths, so it finds those.
//
// Like scan.mjs, this file never opens a connection of its own. It reaches the
// target through one door: the Docker network `net` and the base URL `baseUrl`,
// the same two values startLab() (or a live scope proxy) supplies. The image is
// pinned and built locally (Dockerfile.ffuf), and the run uses --pull=never, so
// ffuf only ever talks to the lab, never a registry or the internet.
//
// A ffuf hit is a LEAD, never a finding. "This path exists" is a hint the agent
// must still prove with a replayed request script that an oracle accepts.
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool } from "../../lib/wrap.mjs";
import { classifyCode, isTimeout } from "./toolrun.mjs";

// Built by spike/scripts/build-labs.sh from packs/web/Dockerfile.ffuf.
export const FFUF_IMAGE = "touchstone/web-ffuf:2.3.0";

const WORDLIST = new URL("./scan/wordlists/content.txt", import.meta.url).pathname;
const cap = (s, n = 200) => String(s ?? "").slice(0, n);
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return String(u ?? ""); } };

// Paths whose mere existence is sensitive. An unauthenticated 2xx here is worth
// more than a generic hit, so the lead ranks higher. Ranking only; a lead is
// still just a lead.
const SENSITIVE = /(^|\/)(internal|admin|debug|config|backup|metrics|status|server-status|\.env|\.git)(\/|$|\.)/i;

// ---- parser: a pure function over ffuf's JSON output. No Docker to test it.
//
// ffuf writes { results: [ { input: { FUZZ }, url, status, length, ... } ] }.
// Its default matcher already drops 404, so a listed result means the path
// answered with something other than "not found". We keep one lead per path.
export function parseFfuf(text) {
  let j;
  try { j = JSON.parse(text); } catch { return []; }
  const byPath = new Map();
  for (const r of Array.isArray(j?.results) ? j.results : []) {
    const path = pathOf(r.url) || (r.input?.FUZZ ? `/${r.input.FUZZ}` : "");
    const status = Number(r.status);
    if (!path || !Number.isFinite(status) || status === 404) continue;
    if (byPath.has(path)) continue;
    const reachable = status < 400;            // 2xx/3xx: served without a session
    const sensitive = SENSITIVE.test(path);
    const impact = reachable ? (sensitive ? "Medium" : "Low") : "Informational";
    byPath.set(path, {
      engine: "ffuf",
      check: "content-discovery",
      impact,
      where: `${path} (HTTP ${status})`,
      path,
      status,
      length: Number(r.length ?? 0),
      description: cap(`ffuf found ${path} by brute force: HTTP ${status}, ${r.length ?? "?"} bytes. ${reachable ? "Served with no credentials." : "Exists but gated behind auth."} Not linked from any page and not in openapi.yaml.`, 240),
    });
  }
  return [...byPath.values()];
}

// True only when `text` is a ffuf report that carries a `results` array. ffuf
// always writes this file and this key, even for a scan that matched nothing
// (`results: []`). So a MISSING file, non-JSON, or a JSON object with no
// `results` array is not a clean "found nothing" -- it is an unparsable report,
// and the run is treated as a gap, never as clean. (Checklist item 2.)
export function ffufHasResults(text) {
  let j;
  try { j = JSON.parse(text); } catch { return false; }
  return Boolean(j) && typeof j === "object" && Array.isArray(j.results);
}

// ---- runner

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

// Run ffuf against { net, baseUrl } with the shipped wordlist. Always resolves;
// never throws. Fails closed: a timeout, a non-zero exit, or an exit-0 run that
// left no parsable report is reported "unavailable" with a reason, never a
// clean "found nothing". Only an exit-0 run with a real results array is "ran"
// (possibly with zero leads). Returns { coverage: [one entry], leads }.
export async function scanFfuf({ net, baseUrl, run = runTool, timeoutMs = 120_000 } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "web-ffuf-"));
  chmodSync(scratch, 0o777);
  cpSync(WORDLIST, join(scratch, "content.txt"));
  try {
    const r = await run({
      image: FFUF_IMAGE, ws: scratch, network: net, timeoutMs,
      cmd: [
        "ffuf", "-u", `${baseUrl}/FUZZ`, "-w", "/work/content.txt",
        "-of", "json", "-o", "/work/ffuf.json",
        "-t", "20", "-timeout", "10", "-s", "-noninteractive",
      ],
    });
    const text = read(join(scratch, "ffuf.json"));
    const unavailable = (reason) => ({
      coverage: [{ engine: "ffuf", status: "unavailable", code: r.code, timedOut: Boolean(r.timedOut), leads: 0, reason: cap(reason, 220) }],
      leads: [],
    });
    // Order matters: a timeout can also carry a non-zero code, so test it first.
    if (isTimeout(r.code, r.timedOut)) {
      return unavailable(`ffuf timed out after ~${Math.round(timeoutMs / 1000)}s (exit ${r.code}); no result from a killed scan is trustworthy. ${cap(r.stderr, 120)}`);
    }
    if (classifyCode(r.code) !== "ok") {
      return unavailable(`ffuf exited ${r.code}; it did not complete a scan. ${cap(r.stderr, 140)}`);
    }
    if (!ffufHasResults(text)) {
      return unavailable("ffuf exited 0 but wrote no parsable report (missing file or no results array); a gap, not a clean scan.");
    }
    const leads = parseFfuf(text);
    return {
      coverage: [{ engine: "ffuf", status: "ran", code: r.code, timedOut: false, leads: leads.length }],
      leads,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
