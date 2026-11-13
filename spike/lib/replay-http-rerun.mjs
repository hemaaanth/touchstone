// Shipped in an HTTP replay bundle as rerun.mjs. Run it from the unzipped folder:
//
//   node rerun.mjs <path to a Touchstone checkout>
//
// It does what the engine's own http proof does (lib/proof-http.mjs, shipped
// next to it): start a fresh lab behind the recording proxy, on two internal
// Docker networks with no internet route, run script.mjs against it, read the
// proxy's transcript, and stop the lab. The new transcript goes to
// replay-transcript.json. Then the pack's named oracle, loaded from the
// Touchstone checkout, reads that transcript.
//
// Exit codes: 0 the oracle passed, 1 it did not, 2 the check could not run
// (no checkout path, the lab image is not built, or the oracle is not found).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requireImage, runRequestScript, startLab, stopLab } from "./proof-http.mjs";

const stop = (code, line) => {
  console.log(line);
  process.exit(code);
};

const meta = JSON.parse(readFileSync("rerun.json", "utf8"));
const script = readFileSync("script.mjs", "utf8");
if (script.includes("[REDACTED]")) {
  console.log("note: script.mjs holds [REDACTED] where a secret value was removed. The rerun sends that text, not the original value.");
}
const repo = process.argv[2] ? resolve(process.argv[2]) : null;
const packFile = repo && join(repo, "spike", "packs", meta.pack, "pack.mjs");
if (!packFile || !existsSync(packFile)) stop(2, "CANNOT CHECK: pass the path to a Touchstone checkout. The oracle is pack code and is not in this folder.");
try {
  await requireImage(meta.image, meta.pack);
} catch (err) {
  stop(2, `CANNOT CHECK: ${err.message}`);
}

const handle = await startLab({ image: meta.image });
let run;
try {
  run = await runRequestScript(handle, script);
} finally {
  await stopLab(handle);
}
writeFileSync("replay-transcript.json", JSON.stringify(run.transcript, null, 2) + "\n");

const { ORACLES } = await import(pathToFileURL(packFile).href);
const oracle = (ORACLES || []).find((o) => o.name === meta.oracle);
if (!oracle) stop(2, `CANNOT CHECK: the ${meta.pack} pack has no oracle named ${meta.oracle}.`);
let verdict;
try {
  verdict = oracle.check(run.transcript, run);
} catch (err) {
  verdict = { pass: false, detail: `oracle threw: ${String(err?.message || err).slice(0, 300)}` };
}
stop(verdict.pass ? 0 : 1, `${verdict.pass ? "OK" : "FAIL"}: ${meta.oracle}: ${verdict.detail ?? ""}`);
