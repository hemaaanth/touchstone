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
// An evidence finding gets no zip (bundleRefusal): its snapshot is raw target
// files. Secrets never go in. Provider keys and bearer tokens are replaced with
// placeholders. A file that is itself a key (a pem, an env file, a cloud
// credential) is left out and named in the README.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pinnedSolc, warmFor } from "./sandbox.mjs";

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

// The replay runs on the image digest the proof ran on, never `:latest`.
// FALLBACK_IMAGE is the digest the labs were proven on; it is used only when
// Docker cannot say which digest `:latest` is on this machine.
const IMAGE_TAG = "ghcr.io/foundry-rs/foundry:latest";
const IMAGE_DIGEST = /^ghcr\.io\/foundry-rs\/foundry@sha256:[a-f0-9]{64}$/;
export const FALLBACK_IMAGE = "ghcr.io/foundry-rs/foundry@sha256:3a392c18f9b16e665e932de159fb6fa9ed972c4b4352f2f76a1a8c7ca9b57d39";
// The judge's own solc cache. The prepare step fills it; the replay only reads it.
export const REPLAY_SVM_VOLUME = "touchstone-replay-svm";
const SOLC = /^\d+\.\d+\.\d+$/;

function localImageDigest() {
  try {
    const out = execFileSync("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", IMAGE_TAG], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    return (JSON.parse(out) || []).find((d) => IMAGE_DIGEST.test(d)) || null;
  } catch {
    return null;
  }
}

const imageOf = (image) => (IMAGE_DIGEST.test(String(image ?? "")) ? image : FALLBACK_IMAGE);

// One shell command, run from the unzipped folder. The Foundry image's
// entrypoint is `sh -c`, so the forge invocation is a single argument.
// --offline and --use stop forge from fetching a compiler; --pull never stops
// Docker from fetching an image. A proof that did not fork runs with
// --network none. A fork needs the RPC, so it keeps the network, and RPC_URL
// is expanded inside the container from the environment, never written here.
export function forgeCommand({ contract, test, fork, solc, image } = {}) {
  const args = ["forge", "test", "--offline"];
  if (SOLC.test(String(solc ?? ""))) args.push("--use", solc);
  if (fork?.forked) {
    args.push("--fork-url", '"$RPC_URL"');
    if (Number.isFinite(fork.block)) args.push("--fork-block-number", String(fork.block));
  }
  if (contract && IDENT.test(contract)) args.push("--match-contract", contract);
  if (test && IDENT.test(test)) args.push("--match-test", test);
  // The JSON trace is what check-harm.mjs reads, as the engine's own replay does.
  args.push("--json", "-vvvv");
  const net = fork?.forked ? " -e RPC_URL" : " --network none";
  return `docker run --rm --pull never${net} -v ${REPLAY_SVM_VOLUME}:/home/foundry/.svm -v "$PWD":/work -w /work ${imageOf(image)} '${args.join(" ")}'`;
}

// Run once, online, before the replay: fetch the pinned image and put each
// solc the proof used in the judge's cache volume. A fresh volume is owned by
// root, and forge runs as uid 1000, so the volume is handed over first.
export function prepareCommand({ solc, solcs, image } = {}) {
  const versions = [...new Set([solc, ...(Array.isArray(solcs) ? solcs : [])].filter((v) => SOLC.test(String(v ?? ""))))];
  if (!versions.length) return null;
  const img = imageOf(image);
  const warm = versions.map((v) => `mkdir -p /tmp/w${v}/src && cd /tmp/w${v} && echo "pragma solidity ${v}; contract W {}" > src/W.sol && forge build --use ${v}`).join(" && ");
  return [
    `docker pull ${img}`,
    `docker volume create ${REPLAY_SVM_VOLUME}`,
    `docker run --rm -u 0 --entrypoint sh -v ${REPLAY_SVM_VOLUME}:/svm ${img} -c 'chown 1000:1000 /svm'`,
    `docker run --rm -v ${REPLAY_SVM_VOLUME}:/home/foundry/.svm ${img} '${warm}'`,
  ].join(" && \\\n  ");
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

// The solc the proof ran with, read the way forgeTest reads it: the workspace
// pin (`--use`), or null for "auto", where forge picks per pragma. `solcs` is
// every version the replay cache needs, the same list warmFor gives Daytona.
function readSolc(ws) {
  const pin = pinnedSolc(ws);
  return pin === "auto" ? { solc: null, solcs: warmFor(ws) } : { solc: pin, solcs: [pin] };
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
    ...readSolc(ws),
    image: localImageDigest() || FALLBACK_IMAGE,
    fork,
    files,
    omitted,
  };
  replay.prepare = prepareCommand(replay);
  replay.command = files.some((f) => f.path === "foundry.toml") && files.some((f) => f.path.startsWith("test/"))
    ? forgeCommand(replay)
    : null;
  return replay;
}

// What an evidence proof keeps for a later export: the pin and the names of
// the captured files. Never the file text. A snapshot holds raw target files
// (.env, hardhat configs, keys), and no redaction layer strips them yet.
const MAX_LISTED = 2000;
export function evidenceReplay(pinned) {
  const f = pinned?.snapshot?.files;
  const names = Array.isArray(f)
    ? f.map((x) => (typeof x === "string" ? x : x?.path ?? x?.file)).filter((x) => typeof x === "string")
    : f && typeof f === "object" ? Object.keys(f) : [];
  return {
    version: 2,
    kind: "evidence",
    snapshotHash: pinned?.snapshotHash ?? null,
    snapshotFiles: names.slice(0, MAX_LISTED),
    snapshotFileCount: names.length,
  };
}

const EVIDENCE_REFUSAL = "An evidence finding has no replay bundle yet. Its pinned snapshot holds raw files from the target, and no redaction layer strips secrets from them. The report's snapshotHash is the proof.";

// Why this finding gets no zip, or null when it gets one.
export function bundleRefusal({ finding, recorded } = {}) {
  const proof = recorded?.proof || finding?.proof || null;
  const replay = recorded?.replay || proof?.replay || null;
  const kind = replay?.kind || proof?.kind || finding?.proofKind || "forge";
  return kind === "evidence" ? EVIDENCE_REFUSAL : null;
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
      ...(replay.prepare ? { prepare: replay.prepare } : {}),
      fork: replay.fork || null,
      contract: replay.contract || null,
      test: replay.test || null,
      omitted: replay.omitted || [],
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

function fence(command, heading = "Command", lead = "Run this from this directory:") {
  return command ? `\n\n## ${heading}\n\n${lead}\n\n\`\`\`sh\n${command}\n\`\`\`\n` : "";
}

function omittedList(omitted) {
  const rows = (omitted || []).filter((o) => o && (o.path || o.reason));
  if (!rows.length) return "";
  return `\n\n## Left out\n\n${rows.map((o) => `- ${o.path ? `\`${o.path}\` — ` : ""}${o.reason}`).join("\n")}\n`;
}

// The replay a reader runs: check the files, rerun the proof, check the harm.
function replaySteps(command) {
  return `sha256sum -c SHA256SUMS && \\\n  ${command} > replay.json && \\\n  node check-harm.mjs replay.json`;
}

const CHECK_HARM = new URL("./replay-check-harm.mjs", import.meta.url);

function sha256Sums(entries) {
  return entries
    .filter((e) => e.name !== "README.md")
    .map((e) => `${createHash("sha256").update(e.data).digest("hex")}  ${e.name}`)
    .join("\n") + "\n";
}

function forgeReadme({ title, replay, command, prepare, fork }) {
  const block = Number.isFinite(fork?.block) ? String(fork.block) : "null";
  if (!command) {
    return `# Replay this finding

**${title || "Finding"}** · Foundry

This snapshot does not include both \`foundry.toml\` and a proof test, so there is no command that can rerun the proof from this folder. \`proof.json\` is the recorded verdict. \`fork.json\` records \`rpc\` as ${rpcShown} and \`block\` as ${block}.

No provider key and no bearer token is included.
${omittedList(replay?.omitted)}`;
  }
  const forkNote = fork?.forked
    ? `This proof forked a chain. Export \`RPC_URL\` to an archive endpoint before the replay. The fork is the only network use, so the replay keeps the network. \`fork.json\` records the block as ${block}. The endpoint is not in this folder.`
    : `This proof did not fork a chain, so the replay runs with \`--network none\`. \`fork.json\` still records \`rpc\` as ${rpcShown} and \`block\` as ${block}, so a later fork has a place to put an endpoint.`;
  const solc = replay?.solc
    ? `The replay compiles with solc ${replay.solc} (\`--use\`), the version the proof used.`
    : `The proof did not pin one solc, so forge picks per pragma from the cache.`;
  const image = `It runs on the image digest the proof ran on, with \`--pull never\` and \`forge --offline\`, so neither Docker nor forge fetches anything.`;
  const prep = prepare
    ? fence(prepare, "Prepare (once, online)", `This pulls the pinned image and puts the solc the proof used into the \`${REPLAY_SVM_VOLUME}\` volume. It is the only step that uses the network for a proof that did not fork.`)
    : `\n\n## Prepare\n\nThis record does not name the solc the proof used. Put a matching solc into the \`${REPLAY_SVM_VOLUME}\` volume before the replay, or the offline replay cannot compile.\n`;
  return `# Replay this finding

**${title || "Finding"}** · Foundry

The proof test, the scope sources, and the Foundry config are in this folder. \`proof.json\` is the recorded verdict. Dependency test suites under \`lib/\` are not included: the proof does not import them, and some ship sample provider keys.

${forkNote} ${solc} ${image} No provider key and no bearer token is in this folder.

The replay has three steps. \`sha256sum -c SHA256SUMS\` fails if any file in this folder, the proof test included, differs from what was recorded. Forge then reruns the named test and writes its JSON trace to \`replay.json\`. \`node check-harm.mjs\` (Node 18 or later) reads that trace and checks it against \`harm.json\`, the harm the engine recorded. It exits 0 when the test passed and the victim lost the recorded wei, 1 when not, and 2 when the recorded harm is not an ETH drain (a token, storage, or control harm needs the engine's storage reader).
${prep}${fence(command && replaySteps(command), "Replay (offline)")}${omittedList(replay?.omitted)}`;
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
  // Rebuild the command from the recorded fields, so a record written before
  // the offline command still gets one.
  const command = haveProject ? forgeCommand({ ...replay, fork }) : null;
  const prepare = haveProject ? prepareCommand(replay) : null;
  const readme = haveProject || files.length
    ? forgeReadme({ title, replay, command, prepare, fork })
    : `# Replay this finding

**${title}** · Foundry

This run was recorded before the workspace was snapshotted, and the workspace is deleted after record. ${testSource ? "The proof test source is in `test/AgentPoc.t.sol`." : "The proof test source was not on the recorded proof."} The scope sources and \`foundry.toml\` were not kept, so there is no command that can rerun the proof from this folder.

\`fork.json\` records \`rpc\` as ${rpcShown} and \`block\` as null. No provider key is included.
`;
  const entries = [];
  pushFile(entries, "README.md", readme);
  pushFile(entries, "proof.json", proofJson(proof, replay && { ...replay, command: command && replaySteps(command), prepare }));
  pushFile(entries, "fork.json", JSON.stringify({ rpc: RPC_PLACEHOLDER, block: Number.isFinite(fork.block) ? fork.block : null, forked: Boolean(fork.forked) }, null, 2) + "\n");
  for (const f of files) pushFile(entries, f.path, f.text);
  if (!files.some((f) => f.path.startsWith("test/")) && testSource) pushFile(entries, "test/AgentPoc.t.sol", scrubReplayText(testSource));
  if (command) {
    const harm = { contract: replay?.contract || null, test: replay?.test || null, harm: scrubValue(proof?.harm ?? null), transfers: scrubValue(proof?.transfers ?? []) };
    pushFile(entries, "harm.json", JSON.stringify(harm, null, 2) + "\n");
    pushFile(entries, "check-harm.mjs", readFileSync(CHECK_HARM, "utf8"));
    pushFile(entries, "SHA256SUMS", sha256Sums(entries));
  }
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

// Zip bytes for one finding. `recorded` is the raw run row (replay snapshot,
// request script, proof). `finding` is the normalized finding the report uses.
// Either may be missing fields; the zip says what it could not include.
export function buildReplayBundle({ finding, recorded } = {}) {
  const refused = bundleRefusal({ finding, recorded });
  if (refused) throw new Error(refused);
  const proof = recorded?.proof || finding?.proof || null;
  const replay = recorded?.replay || proof?.replay || null;
  const kind = replay?.kind || proof?.kind || finding?.proofKind || "forge";
  if (kind === "http") return httpBundle({ finding, recorded, proof });
  return forgeBundle({ finding, replay, proof });
}
