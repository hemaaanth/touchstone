// Offline smoke for the codebase-memory-mcp wrapper (spike/lib/cbm.mjs).
//
// Indexes a tiny local repo and runs the five read-only query tools end to end
// through the wrapper — no network, no account, no API key. Run it under a
// network namespace with no interfaces to PROVE the offline constraint:
//
//   PI_CBM_BIN=<binary> PI_CBM_SKIP_VERSION_CHECK=1 \
//     unshare -rn node spike/test/cbm-smoke.mjs
//
// A non-zero exit means a step failed. The engine binary is pinned by
// tools/fetch-cbm-bin.sh; set PI_CBM_BIN to its install path.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cbm, resolveCbmBinary } from "../lib/cbm.mjs";

const line = (label, value) => console.log(`\n### ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);

const bin = await resolveCbmBinary();
if (!bin) {
  console.error("codebase-memory-mcp binary not found. Set PI_CBM_BIN or run tools/fetch-cbm-bin.sh.");
  process.exit(2);
}
line("binary", bin);

const root = mkdtempSync(join(tmpdir(), "cbm-wrap-smoke-"));
const cacheDir = join(root, ".cache");
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(
  join(root, "src/auth.js"),
  `// tiny sample module
function verifySignature(message, signature, address) {
  const recovered = recover(message, signature);
  return recovered === address;
}
function recover(message, signature) {
  return hashToAddress(message + signature);
}
function login(session, message, signature, address) {
  if (!verifySignature(message, signature, address)) throw new Error("bad signature");
  session.user = address;
  return session;
}
module.exports = { verifySignature, recover, login };
`,
);
// Two files defining the same symbol name, to exercise fail-closed ambiguity.
writeFileSync(join(root, "src/handlers_a.js"), `function handler(req) { return req.a; }\nmodule.exports = { handler };\n`);
writeFileSync(join(root, "src/handlers_b.js"), `function handler(req) { return req.b; }\nmodule.exports = { handler };\n`);

const cbm = new Cbm({ bin, cacheDir });
const project = "cbm-wrap-smoke";
let failed = false;
const expect = (name, cond) => {
  console.log(`  [${cond ? "ok" : "FAIL"}] ${name}`);
  if (!cond) failed = true;
};

try {
  const indexed = await cbm.index(root, { name: project, mode: "fast" });
  line("index_repository (offline)", indexed);
  expect("index reported status=indexed", indexed.status === "indexed");
  expect("index found nodes", (indexed.nodes ?? 0) > 0);

  const resolved = await cbm.resolveSymbol({ project, name: "verifySignature" });
  line("resolve_symbol verifySignature", resolved);
  expect("resolve found exactly one candidate", resolved.total_candidates === 1);
  expect("resolve returned a qualified_name", !!resolved.candidates?.[0]?.qualified_name);

  const read = await cbm.readSymbol({ project, name: "verifySignature" });
  line("read_symbol verifySignature", read);
  expect("read returned source", typeof read.source === "string" && read.source.includes("verifySignature"));
  expect("read carries resolved location", !!read.resolved?.file_path);

  const qn = resolved.candidates[0].qualified_name;
  const snippets = await cbm.getCodeSnippets({ project, qualified_names: [qn] });
  line("get_code_snippets", snippets);
  expect("get_code_snippets returned one", snippets.returned_count === 1);

  const many = await cbm.readSymbols({ project, symbols: [{ name: "login" }, { name: "recover" }] });
  line("read_symbols [login, recover]", many);
  expect("read_symbols read both", many.read_count === 2);

  const sar = await cbm.searchAndReadSymbols({ project, query: "signature", read_limit: 3 });
  line("search_and_read_symbols query=signature", sar);
  expect("search_and_read read at least one", sar.read_count >= 1);

  // read_symbol must FAIL CLOSED on ambiguity: `handler` exists in two files.
  const ambiguous = await cbm.readSymbol({ project, name: "handler" });
  line("read_symbol ambiguous (name=handler, two files)", ambiguous);
  expect("ambiguous read returns >1 candidate, no source", ambiguous.source === undefined && (ambiguous.total_candidates ?? 0) > 1);
  expect("ambiguous read is flagged ambiguous", ambiguous.ambiguous === true);

  // ...but disambiguating by file_path gives exactly one and its source.
  const disambiguated = await cbm.readSymbol({ project, name: "handler", file_path: "handlers_a.js" });
  line("read_symbol disambiguated (handler in handlers_a.js)", disambiguated);
  expect("disambiguated read returns source", typeof disambiguated.source === "string" && disambiguated.source.includes("req.a"));
} catch (e) {
  console.error("\nSMOKE ERROR:", e?.stack || e);
  failed = true;
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n=== cbm wrapper smoke: ${failed ? "FAIL" : "PASS"} ===`);
process.exit(failed ? 1 : 0);
