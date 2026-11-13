// A replayable export of one finding.
//
// The narrative report tells the story. This module is the part a judge can
// rerun. proveFindings (lib/record.mjs) calls snapshotForgeReplay while the
// workspace still exists; the caller deletes that directory after record, so
// the snapshot has to ride on the proof object that gets saved with the run.
// buildReplayBundle turns that snapshot into a zip: the proof test, the scope
// sources, foundry.toml, the proof JSON, fork parameters, and a README whose
// one command reruns the proof from inside the unzipped folder.
//
// Secrets never go in. Provider keys and bearer tokens are replaced with
// placeholders. A file that is itself a key (a pem, an env file, a cloud
// credential) is left out and named in the README.
import { crc32 } from "node:zlib";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_FILE = 1_500_000;
const MAX_TOTAL = 8_000_000;
const SKIP_DIRS = new Set(["node_modules", "out", "cache", "broadcast", "artifacts", "oracle", "coverage", "dist", "target"]);
const SECRET_NAME = [
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn|gpg|asc|crt|cer|der)$/i,
  /^(secrets?|credentials?|service[-_]?account)(\.[\w-]+)?\.(json|ya?ml|toml|txt|ini)$/i,
  /^(secrets?|credentials?)$/i,
  /^wallet\.dat$/i,
  /^(keystore|mnemonic|seed)(\.[\w-]+)?\.(json|txt)$/i,
  /^env$/i,
  /\.env$/i,
];
// A file that is a key, not a source file that mentions one. Dropped whole.
const SECRET_CONTENT = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
];
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const RPC_PLACEHOLDER = "${RPC_URL}";
const KEY_PLACEHOLDER = "${RPC_URL_KEY}";
const BEARER_PLACEHOLDER = "${BEARER_TOKEN}";
// Shown in Markdown. Built by concatenation so the `$` is not eaten by a template.
const rpcShown = "`" + RPC_PLACEHOLDER + "`";
const bearerShown = "`" + BEARER_PLACEHOLDER + "`";

// Replace provider keys and bearer tokens in text a judge will read. The
// placeholders are not credentials. Foundry expands ${RPC_URL} in foundry.toml
// when the judge exports that variable; it is never a real endpoint.
export function scrubReplayText(text) {
  let s = String(text ?? "");
  s = s.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${BEARER_PLACEHOLDER}`);
  s = s.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, BEARER_PLACEHOLDER);
  s = s.replace(/(authorization\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, `$1"Bearer ${BEARER_PLACEHOLDER}"`);
  s = s.replace(/((?:x-api-key|api-key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, `$1"${KEY_PLACEHOLDER}"`);
  // A separator is required (`private_key`, not the Solidity name `privateKey`),
  // and the value has to look like a secret. Replacing an arbitrary expression
  // would break the proof test.
  s = s.replace(/\b((?:api|private|secret|alchemy|infura)[_-]key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9+/=._:-]{8,})/gi, `$1="${KEY_PLACEHOLDER}"`);
  s = s.replace(/(https?:\/\/[^\s"'\\]*\/(?:v[0-9]|api)\/)([A-Za-z0-9_-]{8,})/g, `$1${KEY_PLACEHOLDER}`);
  s = s.replace(/([?&](?:api[_-]?key|apikey|key|token|access[_-]?token)=)[^&\s"'\\]+/gi, `$1${KEY_PLACEHOLDER}`);
  return s;
}

function secretFile(name) {
  const base = name.split("/").pop();
  return SECRET_NAME.some((re) => re.test(base));
}

function secretBody(text) {
  return SECRET_CONTENT.some((re) => re.test(text));
}

// foundry.toml may name an RPC. Keep the block number; replace every endpoint
// value so a provider key in the URL cannot leave with the bundle.
function scrubFoundryToml(text) {
  let inRpc = false;
  const lines = String(text).split("\n").map((line) => {
    if (/^\s*\[/.test(line)) inRpc = /^\s*\[rpc_endpoints\]/.test(line);
    if (/^\s*(?:eth_rpc_url|rpc_url)\s*=/.test(line) || (inRpc && /^\s*[A-Za-z0-9_-]+\s*=/.test(line))) {
      return line.replace(/=.*/, `= "${RPC_PLACEHOLDER}"`);
    }
    return line;
  });
  return scrubReplayText(lines.join("\n"));
}

function testIdent(raw) {
  const s = String(raw ?? "").replace(/\(.*$/, "").trim();
  return IDENT.test(s) ? s : null;
}

// One shell command, run from the unzipped folder. The Foundry image's
// entrypoint is `sh -c`, so the forge invocation is a single argument.
// RPC_URL is expanded inside the container from the environment, never written
// into the bundle. No --network none: a fresh image has no solc cached, and
// forge has to fetch the compiler the pragma names. A fork also needs the RPC.
export function forgeCommand({ contract, test, fork } = {}) {
  const args = ["forge", "test"];
  if (fork?.forked) {
    args.push("--fork-url", '"$RPC_URL"');
    if (Number.isFinite(fork.block)) args.push("--fork-block-number", String(fork.block));
  }
  if (contract && IDENT.test(contract)) args.push("--match-contract", contract);
  if (test && IDENT.test(test)) args.push("--match-test", test);
  const env = fork?.forked ? " -e RPC_URL" : "";
  return `docker run --rm${env} -v "$PWD":/work -w /work ghcr.io/foundry-rs/foundry:latest '${args.join(" ")}'`;
}

function forkFrom(toml, sources) {
  let block = null;
  let forked = false;
  const pinned = String(toml).match(/^\s*fork_block_number\s*=\s*["']?(\d+)/m);
  if (pinned) {
    block = Number(pinned[1]);
    forked = true;
  }
  if (/^\s*(?:eth_rpc_url|rpc_url)\s*=\s*\S/m.test(toml)) forked = true;
  if (/\[rpc_endpoints\][\s\S]*https?:\/\//.test(toml)) forked = true;
  for (const m of String(sources).matchAll(/\.create(?:Select)?Fork\s*\(\s*(?:"[^"]*"|'[^']*'|\w+)(?:\s*,\s*(\d+))?/g)) {
    forked = true;
    if (m[1] && block == null) block = Number(m[1]);
  }
  return { rpc: RPC_PLACEHOLDER, block, forked };
}

function rank(path) {
  if (path === "foundry.toml" || path === "remappings.txt") return 0;
  if (path.startsWith("test/")) return 1;
  if (path.startsWith("src/")) return 2;
  if (path.startsWith("lib/")) return 3;
  return 4;
}

function keepPath(rel) {
  const base = rel.split("/").pop();
  if (!base || base.startsWith(".")) return false;
  if (base === "foundry.toml" || base === "remappings.txt") return !rel.includes("/");
  return base.endsWith(".sol");
}

// Walk the workspace for the files a forge test needs. Dependency tests under
// lib/ are skipped: they are not imported by the proof, and forge-std's own
// tests ship sample provider keys.
function collectFiles(root) {
  const found = [];
  const walk = (dir, parts) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if ((e.name === "test" || e.name === "tests") && parts.includes("lib")) continue;
        walk(join(dir, e.name), [...parts, e.name]);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = [...parts, e.name].join("/");
      if (keepPath(rel)) found.push(rel);
    }
  };
  walk(root, []);
  found.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  return found;
}

function readSolc(ws) {
  try {
    const raw = JSON.parse(readFileSync(join(ws, ".touchstone.json"), "utf8")).solc;
    const v = String(raw ?? "").trim().replace(/^=/, "");
    return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

// Snapshot the workspace that just proved a forge finding. Call this before
// the workspace is deleted. The result is JSON-safe and is stored on the proof.
export function snapshotForgeReplay(ws, { contract, test } = {}) {
  const paths = collectFiles(ws);
  const files = [];
  const omitted = [];
  let total = 0;
  let capped = 0;
  for (const rel of paths) {
    if (secretFile(rel)) {
      omitted.push({ path: rel, reason: "secret file" });
      continue;
    }
    let buf;
    try { buf = readFileSync(join(ws, rel)); } catch { continue; }
    if (buf.length > MAX_FILE) {
      omitted.push({ path: rel, reason: "larger than 1.5 MB" });
      continue;
    }
    if (buf.includes(0)) {
      omitted.push({ path: rel, reason: "binary" });
      continue;
    }
    const raw = buf.toString("utf8");
    if (secretBody(raw)) {
      omitted.push({ path: rel, reason: "secret file" });
      continue;
    }
    if (total + raw.length > MAX_TOTAL) {
      capped++;
      continue;
    }
    total += raw.length;
    const text = rel === "foundry.toml" ? scrubFoundryToml(raw) : scrubReplayText(raw);
    files.push({ path: rel, text });
  }
  if (capped) omitted.push({ path: "", reason: `bundle size cap; ${capped} file${capped === 1 ? "" : "s"} left out` });
  let toml = "";
  try {
    if (paths.includes("foundry.toml")) toml = readFileSync(join(ws, "foundry.toml"), "utf8");
  } catch {
    toml = "";
  }
  const sources = files.filter((f) => f.path.endsWith(".sol")).map((f) => f.text).join("\n");
  // Fork detection reads the original toml (endpoints still present) and the
  // scrubbed sources (block numbers are not secrets). The URL itself is not kept.
  const fork = forkFrom(toml, sources);
  const replay = {
    version: 1,
    kind: "forge",
    contract: testIdent(contract),
    test: testIdent(test),
    solc: readSolc(ws),
    fork,
    files,
    omitted,
  };
  replay.command = files.some((f) => f.path === "foundry.toml") && files.some((f) => f.path.startsWith("test/"))
    ? forgeCommand(replay)
    : null;
  return replay;
}

// The pinned snapshot, as bytes a judge can hash. Scrubbing a secret changes
// the bytes, so the recorded hash will not match; `scrubbed` says so.
export function evidenceReplay(pinned) {
  const raw = JSON.stringify(pinned?.snapshot ?? null);
  if (raw.length > MAX_TOTAL) {
    return {
      version: 1,
      kind: "evidence",
      snapshotHash: pinned?.snapshotHash ?? null,
      scrubbed: false,
      files: [],
      omitted: [{ path: "snapshot.json", reason: "snapshot is larger than the bundle cap" }],
    };
  }
  const text = scrubReplayText(raw);
  return {
    version: 1,
    kind: "evidence",
    snapshotHash: pinned?.snapshotHash ?? null,
    scrubbed: text !== raw,
    files: [{ path: "snapshot.json", text }],
    omitted: text !== raw ? [{ path: "snapshot.json", reason: "provider keys and bearer tokens were replaced; sha256sum will not match the recorded pin" }] : [],
  };
}

function scrubValue(value, key = "") {
  if (typeof value === "string") {
    if (/secret|private|token|passw|api[-_]?key|credential|authorization|cookie|session|bearer/i.test(key) && value) return "${REDACTED}";
    return scrubReplayText(value);
  }
  if (Array.isArray(value)) return value.map((v) => scrubValue(v));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "controlTrace") continue;
      if (k === "replay") continue;
      out[k] = scrubValue(v, k);
    }
    return out;
  }
  return value;
}

function proofJson(proof, replay) {
  const body = scrubValue(proof || {});
  if (replay) {
    body.replay = {
      command: replay.command || null,
      fork: replay.fork || null,
      contract: replay.contract || null,
      test: replay.test || null,
      omitted: replay.omitted || [],
      scrubbed: Boolean(replay.scrubbed),
    };
  }
  return JSON.stringify(body, null, 2) + "\n";
}

function zipPath(name) {
  const parts = String(name).split("/").filter(Boolean);
  if (!parts.length || parts.some((p) => p === ".." || p === "." || p.startsWith("\\") || p.includes("\0"))) return null;
  return parts.join("/");
}

// A stored-method zip. No extra dependency: the report route returns these bytes.
export function zipStore(entries) {
  const locals = [];
  const parts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
    const crc = crc32(data) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    parts.push(header, name, data);
    locals.push({ name, crc, size: data.length, offset });
    offset += header.length + name.length + data.length;
  }
  const cdStart = offset;
  for (const l of locals) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(0x0800, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(0, 12);
    h.writeUInt16LE(0, 14);
    h.writeUInt32LE(l.crc, 16);
    h.writeUInt32LE(l.size, 20);
    h.writeUInt32LE(l.size, 24);
    h.writeUInt16LE(l.name.length, 28);
    h.writeUInt16LE(0, 30);
    h.writeUInt16LE(0, 32);
    h.writeUInt16LE(0, 34);
    h.writeUInt16LE(0, 36);
    h.writeUInt32LE(0, 38);
    h.writeUInt32LE(l.offset, 42);
    parts.push(h, l.name);
    offset += h.length + l.name.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(locals.length, 8);
  eocd.writeUInt16LE(locals.length, 10);
  eocd.writeUInt32LE(offset - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);
  return Buffer.concat(parts);
}

function fence(command) {
  return command ? `\n\n## Command\n\nRun this from this directory:\n\n\`\`\`sh\n${command}\n\`\`\`\n` : "";
}

function omittedList(omitted) {
  const rows = (omitted || []).filter((o) => o && (o.path || o.reason));
  if (!rows.length) return "";
  return `\n\n## Left out\n\n${rows.map((o) => `- ${o.path ? `\`${o.path}\` — ` : ""}${o.reason}`).join("\n")}\n`;
}

function forgeReadme({ title, replay, command, fork }) {
  const block = Number.isFinite(fork?.block) ? String(fork.block) : "null";
  if (!command) {
    return `# Replay this finding

**${title || "Finding"}** · Foundry

This snapshot does not include both \`foundry.toml\` and a proof test, so there is no command that can rerun the proof from this folder. \`proof.json\` is the recorded verdict. \`fork.json\` records \`rpc\` as ${rpcShown} and \`block\` as ${block}.

No provider key and no bearer token is included.
${omittedList(replay?.omitted)}`;
  }
  const forkNote = fork?.forked
    ? `This proof forked a chain. Export \`RPC_URL\` to an archive endpoint before the command below. \`fork.json\` records the block as ${block}. The endpoint is not in this folder.`
    : `This proof did not fork a chain. \`fork.json\` still records \`rpc\` as ${rpcShown} and \`block\` as ${block}, so a later fork has a place to put an endpoint. The command below does not fork.`;
  const solc = replay?.solc ? ` The run pinned solc ${replay.solc}; forge will use a compiler that satisfies the sources' pragma.` : "";
  return `# Replay this finding

**${title || "Finding"}** · Foundry

The proof test, the scope sources, and the Foundry config are in this folder. \`proof.json\` is the recorded verdict. Dependency test suites under \`lib/\` are not included: the proof does not import them, and some ship sample provider keys.

${forkNote}${solc} A fresh Foundry image has no compiler cached, so the command lets forge download the solc the pragma names. That download is the only network use when the proof did not fork. No provider key and no bearer token is in this folder.
${fence(command)}${omittedList(replay?.omitted)}`;
}

function httpReadme({ title, hasScript }) {
  const script = hasScript
    ? `The request script is \`script.mjs\`. Bearer tokens in it were replaced with ${bearerShown}.`
    : `The request script was not on the recorded finding, so it is not in this folder.`;
  return `# Replay this finding

**${title || "Finding"}** · HTTP oracle

${script} The recorded request and response transcript is \`transcript.json\`. The oracle verdict is \`proof.json\`.

## What cannot be bundled

The practice service is a pack lab image on a private Docker network, and the oracle is pack code that reads the proxy's transcript. Neither is in this zip. There is no command in this folder that reruns the proof. Rebuilding the lab (\`npm run build:labs\` in the Touchstone repo) and replaying through the pack is required.

No provider key and no bearer token is included. A token the script sent is ${bearerShown} here; export that name yourself if you rebuild the lab and rerun the script.
`;
}

function evidenceReadme({ title, replay, hash }) {
  const have = (replay?.files || []).some((f) => f.path === "snapshot.json");
  const command = have ? "sha256sum snapshot.json" : null;
  const pin = hash ? `The run recorded \`snapshotHash\` \`${hash}\`.` : "The run did not record a snapshot hash.";
  const match = !have
    ? "The pinned snapshot bytes were not kept with this finding. The workspace is deleted after record, and this run stored only the hash, so the check cannot be rerun from this folder."
    : replay?.scrubbed
      ? `${pin} Provider keys and bearer tokens were removed from \`snapshot.json\`, so the hash of this file will not equal the recorded pin.`
      : `${pin} The command below hashes \`snapshot.json\`. It must equal that pin.`;
  return `# Replay this finding

**${title || "Finding"}** · Pinned evidence

${match}

## What cannot be bundled

The detector that interprets the snapshot is pack code. It is not in this zip, so the check itself cannot be re-executed here. ${have ? "The command only confirms the bytes still match the pin." : "What this folder can show is the check name and the hash in `proof.json`."}
${fence(command)}${omittedList(replay?.omitted)}`;
}

function pushFile(entries, name, text) {
  const path = zipPath(name);
  if (!path || entries.some((e) => e.name === path)) return;
  entries.push({ name: path, data: Buffer.from(String(text), "utf8") });
}

function forgeBundle({ finding, replay, proof }) {
  const title = finding?.title || "Finding";
  const files = Array.isArray(replay?.files) ? replay.files : [];
  const testSource = proof?.testSource || finding?.proof?.testSource || null;
  const haveProject = files.some((f) => f.path === "foundry.toml") && files.some((f) => f.path.startsWith("test/"));
  const fork = replay?.fork || { rpc: RPC_PLACEHOLDER, block: null, forked: false };
  const command = haveProject ? (replay.command || forgeCommand({ contract: replay?.contract, test: replay?.test, fork })) : null;
  const readme = haveProject || files.length
    ? forgeReadme({ title, replay, command, fork })
    : `# Replay this finding

**${title}** · Foundry

This run was recorded before the workspace was snapshotted, and the workspace is deleted after record. ${testSource ? "The proof test source is in `test/AgentPoc.t.sol`." : "The proof test source was not on the recorded proof."} The scope sources and \`foundry.toml\` were not kept, so there is no command that can rerun the proof from this folder.

\`fork.json\` records \`rpc\` as ${rpcShown} and \`block\` as null. No provider key is included.
`;
  const entries = [];
  pushFile(entries, "README.md", readme);
  pushFile(entries, "proof.json", proofJson(proof, replay));
  pushFile(entries, "fork.json", JSON.stringify({ rpc: RPC_PLACEHOLDER, block: Number.isFinite(fork.block) ? fork.block : null, forked: Boolean(fork.forked) }, null, 2) + "\n");
  for (const f of files) pushFile(entries, f.path, f.text);
  if (!files.some((f) => f.path.startsWith("test/")) && testSource) pushFile(entries, "test/AgentPoc.t.sol", scrubReplayText(testSource));
  return zipStore(entries);
}

function httpBundle({ finding, recorded, proof }) {
  const script = recorded?.script ?? finding?.script ?? null;
  const text = script ? scrubReplayText(script) : null;
  const transcript = scrubValue(Array.isArray(proof?.log) ? proof.log : Array.isArray(proof?.exchanges) ? proof.exchanges : []);
  const entries = [];
  pushFile(entries, "README.md", httpReadme({ title: finding?.title, hasScript: Boolean(text) }));
  pushFile(entries, "proof.json", proofJson(proof, null));
  pushFile(entries, "transcript.json", JSON.stringify(transcript, null, 2) + "\n");
  if (text) pushFile(entries, "script.mjs", text.endsWith("\n") ? text : text + "\n");
  return zipStore(entries);
}

function evidenceBundle({ finding, replay, proof }) {
  const hash = replay?.snapshotHash || proof?.snapshotHash || finding?.evidence?.snapshotHash || null;
  const entries = [];
  pushFile(entries, "README.md", evidenceReadme({ title: finding?.title, replay, hash }));
  pushFile(entries, "proof.json", proofJson({ ...(proof || {}), snapshotHash: hash }, replay));
  for (const f of replay?.files || []) pushFile(entries, f.path, f.text);
  return zipStore(entries);
}

// Zip bytes for one finding. `recorded` is the raw run row (replay snapshot,
// request script, proof). `finding` is the normalized finding the report uses.
// Either may be missing fields; the zip says what it could not include.
export function buildReplayBundle({ finding, recorded } = {}) {
  const proof = recorded?.proof || finding?.proof || null;
  const replay = recorded?.replay || proof?.replay || null;
  const kind = replay?.kind || proof?.kind || finding?.proofKind || "forge";
  if (kind === "http") return httpBundle({ finding, recorded, proof });
  if (kind === "evidence") return evidenceBundle({ finding, replay, proof });
  return forgeBundle({ finding, replay, proof });
}
