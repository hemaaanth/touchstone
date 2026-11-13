// Schemathesis API schema fuzzing for the Web pack's prepass. Schemathesis
// reads the target's OpenAPI schema and generates schema-valid (and boundary)
// inputs for every documented operation, then checks each response. The three
// scanners in scan.mjs (zap spider, nuclei templates, dalfox) and ffuf/arjun
// probe paths and parameters by wordlist; none of them drive a TYPED path or
// query parameter against the documented schema. So a handler that accepts a
// well-typed but out-of-range value and crashes -- an HTTP 500 where a 4xx was
// due -- is invisible to them. Schemathesis generates exactly those inputs, so
// it finds that class of server-error / schema-conformance bug.
//
// Like scan.mjs and ffuf.mjs, this file never opens a connection of its own. It
// reaches the target through one door: the Docker network `net` and the base
// URL `baseUrl`, the same two values startLab() (or a live scope proxy)
// supplies. The schema it drives is the pack's documented input,
// lab/dapp/openapi.yaml, copied into the run scratch and mounted read-only to
// the tool. The image is pinned and built locally (Dockerfile.schemathesis) and
// the run uses --pull=never, so Schemathesis only ever talks to the lab, never
// a registry or the internet.
//
// A Schemathesis failure is a LEAD, never a finding. "This operation returned a
// 500 on a schema-valid input" is a hint the agent must still reproduce with a
// replayed request an oracle accepts.
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool } from "../../lib/wrap.mjs";
import { isTimeout } from "./toolrun.mjs";

// Built by spike/scripts/build-labs.sh from packs/web/Dockerfile.schemathesis.
export const SCHEMATHESIS_IMAGE = "touchstone/web-schemathesis:4.33.4";

// The pack's documented input. The prepass drives the lab's own published
// schema; a real engagement would point this at the target's published schema.
const SCHEMA = new URL("./lab/dapp/openapi.yaml", import.meta.url).pathname;

const cap = (s, n = 200) => String(s ?? "").slice(0, n);

// Split a Schemathesis operation label ("GET /api/block/{height}") into method
// and path. Returns { method, path } with sensible fallbacks.
function splitOp(op) {
  const s = String(op ?? "").trim();
  const i = s.indexOf(" ");
  if (i < 0) return { method: "", path: s };
  return { method: s.slice(0, i), path: s.slice(i + 1) };
}

// ---- report reader: a pure function over Schemathesis's JSON run report.
//
// Schemathesis writes { complete, exit_code, operations, failures: [...], ... }.
// It exits 0 when nothing failed and 1 when a check failed -- so exit code
// alone cannot tell "clean" from "found a bug"; both are a completed run. The
// report's own `complete: true` is the ground truth that the run finished, and
// `operations.tested` tells us it actually exercised the API. A missing file,
// non-JSON, `complete` not true, or zero operations tested is NOT a clean
// "found nothing" -- it is an unusable report, and the run is a gap.
//
// Returns the parsed object when the report shows a completed run that tested
// at least one operation, else null.
export function schemathesisReport(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  if (j.complete !== true) return null;
  if (!Array.isArray(j.failures)) return null;
  const tested = Number(j?.operations?.tested);
  if (!Number.isFinite(tested) || tested < 1) return null;
  return j;
}

// Turn a completed report's `failures` into leads. Each failure names one or
// more operations; we emit one lead per operation. A clean run (no failures)
// yields []. `report` is the object schemathesisReport returned.
export function parseSchemathesis(report) {
  const j = report && typeof report === "object" ? report : null;
  const failures = Array.isArray(j?.failures) ? j.failures : [];
  const byPath = new Map();
  for (const f of failures) {
    const code = cap(f?.code || "", 20) || "ST";
    const title = cap(f?.title || "schema-conformance failure", 80);
    const ops = Array.isArray(f?.operations) ? f.operations : [];
    for (const op of ops) {
      const { method, path } = splitOp(op);
      if (!path) continue;
      // A server error (ST101) is a real robustness/conformance fault, but it
      // is still an unproven lead, so it ranks Medium, not High. Any other
      // conformance check we might add later is Low until shown otherwise.
      const impact = code === "ST101" ? "Medium" : "Low";
      if (byPath.has(path)) continue; // one lead per path
      byPath.set(path, {
        engine: "schemathesis",
        check: `schema-fuzz:${code}`,
        impact,
        where: `${method ? method + " " : ""}${path} (${code} ${title})`,
        path,
        description: cap(`Schemathesis drove schema-valid inputs at ${method ? method + " " : ""}${path} from openapi.yaml and the response tripped ${code} (${title}). A well-typed but out-of-range input gets an HTTP 5xx where a 4xx was due. A lead: the agent must reproduce it and prove impact.`, 240),
      });
    }
  }
  return [...byPath.values()];
}

// ---- runner

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

// Run Schemathesis against { net, baseUrl } using the pack's openapi.yaml.
// Always resolves; never throws. Fails closed: a timeout, or a run that left no
// usable report (missing/non-JSON/not complete/zero operations tested) is
// reported "unavailable" with a reason, never a clean "found nothing". A
// completed run that tested the API is "ran" (exit 0 with no failures, or exit
// 1 with failures -- both are completed runs). Returns { coverage, leads }.
export async function scanSchemathesis({
  net,
  baseUrl,
  run = runTool,
  timeoutMs = 90_000,
  maxTimeSec = 30,
  maxExamples = 10,
  seed = 1,
} = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "web-schemathesis-"));
  chmodSync(scratch, 0o777);
  cpSync(SCHEMA, join(scratch, "openapi.yaml"));
  try {
    const r = await run({
      image: SCHEMATHESIS_IMAGE, ws: scratch, network: net, timeoutMs,
      cmd: [
        "schemathesis", "run", "/work/openapi.yaml", "-u", baseUrl,
        "-c", "not_a_server_error",
        "--phases", "coverage,fuzzing",
        "-n", String(maxExamples),
        "--seed", String(seed),
        "--max-time", String(maxTimeSec),
        "--no-color",
        "--report", "json",
        "--report-json-path", "/work/report.json",
        "--report-dir", "/work",
      ],
    });
    const text = read(join(scratch, "report.json"));
    const unavailable = (reason) => ({
      coverage: [{ engine: "schemathesis", status: "unavailable", code: r.code, timedOut: Boolean(r.timedOut), leads: 0, reason: cap(reason, 220) }],
      leads: [],
    });
    // Order matters: a timeout can also carry a non-zero code, so test it first.
    if (isTimeout(r.code, r.timedOut)) {
      return unavailable(`schemathesis timed out after ~${Math.round(timeoutMs / 1000)}s (exit ${r.code}); no result from a killed run is trustworthy. ${cap(r.stderr, 100)}`);
    }
    // Exit code alone does not decide here: 0 = no failures, 1 = failures found,
    // both completed. The report's own `complete`/`tested` is the ground truth.
    const report = schemathesisReport(text);
    if (!report) {
      return unavailable(`schemathesis left no usable report (missing, non-JSON, not complete, or zero operations tested); a gap, not a clean run. exit ${r.code}. ${cap(r.stderr, 120)}`);
    }
    const leads = parseSchemathesis(report);
    return {
      coverage: [{ engine: "schemathesis", status: "ran", code: r.code, timedOut: false, leads: leads.length }],
      leads,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
