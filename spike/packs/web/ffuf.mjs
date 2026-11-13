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

// ---- runner

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

// Run ffuf against { net, baseUrl } with the shipped wordlist. Always resolves.
// A tool that fails is reported "unavailable" with its exit code; it never
// throws. Returns { coverage: [one entry], leads } in scanWeb's shape.
export async function scanFfuf({ net, baseUrl, run = runTool, timeoutMs = 120_000 } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "web-ffuf-"));
  chmodSync(scratch, 0o777);
  cpSync(WORDLIST, join(scratch, "content.txt"));
  try {
    const r = await run({
      image: FFUF_IMAGE, ws: scratch, network: net, pull: "never", timeoutMs,
      cmd: [
        "ffuf", "-u", `${baseUrl}/FUZZ`, "-w", "/work/content.txt",
        "-of", "json", "-o", "/work/ffuf.json",
        "-t", "20", "-timeout", "10", "-s", "-noninteractive",
      ],
    });
    const leads = parseFfuf(read(join(scratch, "ffuf.json")));
    // ffuf exits 0 on a clean scan. Non-zero AND no parsed leads = it failed:
    // report it unavailable, never a clean "found nothing".
    const status = r.code === 0 || leads.length ? "ran" : "unavailable";
    return {
      coverage: [{
        engine: "ffuf",
        status,
        code: r.code,
        timedOut: Boolean(r.timedOut),
        leads: leads.length,
        ...(status === "unavailable"
          ? { reason: `ffuf exited ${r.code}${r.timedOut ? " (timed out)" : ""} with no parsable results. ${cap(r.stderr, 160)}` }
          : {}),
      }],
      leads,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
