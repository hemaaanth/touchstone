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
// files. Secrets never go in. Every text passes through app/server/redact.mjs
// (bundleText, bundleValue), and leakShapes fails closed on the shapes that
// module does not mask. A file that is itself a key (a pem, an env file, a
// cloud credential) is left out and named in the README.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "../../app/server/redact.mjs";
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
const ETHERSCAN_PLACEHOLDER = "${ETHERSCAN_API_KEY}";
// Shown in Markdown. Built by concatenation so the `$` is not eaten by a template.
const rpcShown = "`" + RPC_PLACEHOLDER + "`";
const MARK = "[REDACTED]";

// Every text that goes into a zip passes through bundleText or bundleValue.
// The secret rules are app/server/redact.mjs, the same module the report
// formats use. The steps here only feed that module text it can read:
//  - a forge file gets ${RPC_URL_KEY} for a key in a URL path, so a provider
//    key cannot leave and forge-std's StdChains.sol still compiles;
//  - a home directory becomes "~";
//  - a comment line ("// Cookie: …", "# Authorization: …") is redacted again
//    without its comment mark, so the module sees a header at a line start;
//  - `name = "value"` and `name: "value"` (an unquoted JS key, a Solidity or
//    TOML assignment) are given to the module as one {name: value} pair.
// After that, leakShapes checks for the shapes the module does not mask. A
// hit fails closed: a source file is left out, any other file stops the zip.
const URL_IN_TEXT = /https?:\/\/[^\s"'`\\<>()]+/g;
function urlKeys(text) {
  return text.replace(URL_IN_TEXT, (url) =>
    url.replace(/\/([A-Za-z0-9_-]{20,})(?=[/?#]|$)/g, (m, seg) =>
      /[0-9]/.test(seg) && /[A-Za-z]/.test(seg) && !/^0x/i.test(seg) ? `/${KEY_PLACEHOLDER}` : m));
}

const HOME = homedir();
// /home/foundry is the Foundry image's own home, used by the replay command.
const HOME_PATH = /\/(?:home|Users)\/(?!foundry\b)[A-Za-z0-9._-]+/g;
function homeToTilde(text) {
  let s = text;
  if (HOME && HOME.length > 1 && HOME !== "/home/foundry") s = s.split(HOME).join("~");
  return s.replace(HOME_PATH, "~");
}

const COMMENT_LINE = /^([ \t]*(?:\/\/+|\/\*+|\*+|#+|--|;+)[ \t]*)(\S.*)$/gm;
const ASSIGN = /(?<![\w$-])([A-Za-z_][\w-]{0,63})([ \t]*[:=][ \t]*)(["'`])((?:(?!\3)[^\\\r\n]|\\[^\r\n]){1,1024})\3/g;

function secretish(tok, min) {
  if (tok.length < min || tok.startsWith("[REDACTED") || /^(?:\$\{|[<$])/.test(tok)) return false;
  if (/[0-9_\-./+=]/.test(tok)) return true;
  if (tok.length >= 12 && /[a-z]/.test(tok) && /[A-Z]/.test(tok)) return true;
  return tok.length >= 20;
}

function maskAssign(m, name, sep, q, value) {
  if (!secretish(value.trim(), 6)) return m;
  const out = redactSecrets({ [name]: value })[name];
  return out === value ? m : `${name}${sep}${q}${MARK}${q}`;
}

export function bundleText(text, { forge = false } = {}) {
  let s = String(text ?? "");
  if (forge) s = urlKeys(s);
  s = homeToTilde(s);
  s = redactSecrets(s);
  s = s.replace(COMMENT_LINE, (m, lead, rest) => lead + redactSecrets(rest));
  return s.replace(ASSIGN, maskAssign);
}

// A JSON value for the zip: no controlTrace, no stored replay snapshot, every
// string through bundleText. A two-string array (a header list as
// [name, value] pairs) is shown to the module as a {name, value} cell.
const PAIR = "__touchstonePair";
function dropKeys(v) {
  if (Array.isArray(v)) return v.map(dropKeys);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (k !== "controlTrace" && k !== "replay") out[k] = dropKeys(x);
  return out;
}
function toCells(v) {
  if (Array.isArray(v)) {
    if (v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string") return { name: v[0], value: v[1], [PAIR]: true };
    return v.map(toCells);
  }
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = toCells(x);
  return out;
}
function fromCells(v) {
  if (typeof v === "string") return bundleText(v);
  if (Array.isArray(v)) return v.map(fromCells);
  if (!v || typeof v !== "object") return v;
  if (v[PAIR] === true) return [fromCells(v.name), fromCells(v.value)];
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = fromCells(x);
  return out;
}
export function bundleValue(value) {
  // The first pass masks arrays under a secret key; the second sees the pairs.
  return fromCells(redactSecrets(toCells(redactSecrets(dropKeys(value ?? null)))));
}

// Shapes redact.mjs does not mask, found after redaction. Each result is a
// shape name, never the matched text.
const HEX64 = /(?<![0-9A-Za-z])(?:0x)?[0-9a-fA-F]{64}(?![0-9A-Za-z])/;
const KEY_WORD = /private[\s_-]?key|privkey|secret|mnemonic|seed|signer|deployer|wallet|(?<![A-Za-z])(?:pk|sk|key)(?![A-Za-z])|_key(?![A-Za-z])/i;
const KEY_CAMEL = /[a-z]Key(?![a-z])/;
const AWS_WORD = /aws/i;
const AWS_SECRET = /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;
const MNEMONIC_QUOTED = /["'`]\s*((?:[a-z]{3,8}\s+){11,23}[a-z]{3,8})\s*["'`]/g;
const MNEMONIC_NAMED = /(?:mnemonic|seed[\s_-]?phrase|recovery[\s_-]?phrase)\W{0,8}((?:[a-z]{3,8}\s+){11}[a-z]{3,8})/i;
const RPC_HOST = /https?:\/\/[^\s"'`\\/]*(?:alchemy|infura|ankr|quiknode|quicknode|blastapi|chainstack|getblock|nodereal|drpc|tenderly|moralis|blockpi|pokt)[^\s"'`\\/]*([^\s"'`\\]*)/gi;
const NAMED = /([A-Za-z][\w-]{0,63})["'`]?[ \t]*[:=][ \t]*["'`]([^"'`\r\n]{1,1024})["'`]/g;
const SECRET_NAME_END = /(?:api[\s_-]?key|apikey|secret|password|passwd|token|cookie|auth|authorization|private[\s_-]?key|privkey|mnemonic|credentials?|session)$/i;
const HEADER_IN_TEXT = /(?:^|[^\w-])(cookie|set-cookie|authorization|proxy-authorization|x-[\w-]*(?:token|key|secret|auth|session))[ \t]*:[ \t]*(.+)$/i;

const words = (s) => s.split(/[\s,;"'`]+/).filter(Boolean);
const PLAIN = /^(?:\[REDACTED[^\]]*\]|\$\{[A-Z0-9_]+\}|(?:0x)?[0-9a-fA-F]{40})$/;

export function leakShapes(text) {
  const found = new Set();
  for (const line of String(text ?? "").split(/\r?\n|\\n/)) {
    if (HEX64.test(line) && (KEY_WORD.test(line) || KEY_CAMEL.test(line))) found.add("a 64-hex key");
    if (AWS_WORD.test(line)) {
      for (const [t] of line.matchAll(AWS_SECRET)) {
        if (/[a-z]/.test(t) && /[A-Z]/.test(t) && /[0-9]/.test(t) && !/^[0-9a-fA-F]+$/.test(t)) found.add("an AWS secret key");
      }
    }
    for (const m of line.matchAll(MNEMONIC_QUOTED)) {
      if ([12, 15, 18, 21, 24].includes(m[1].split(/\s+/).length)) found.add("a mnemonic");
    }
    if (MNEMONIC_NAMED.test(line)) found.add("a mnemonic");
    for (const m of line.matchAll(RPC_HOST)) {
      if (m[1].split(/[/?#&=]/).some((seg) => seg.length >= 16 && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg) && !seg.startsWith("${"))) found.add("an RPC provider key");
    }
    for (const m of line.matchAll(NAMED)) {
      const v = m[2].trim();
      if (SECRET_NAME_END.test(m[1]) && !PLAIN.test(v) && words(v).some((w) => secretish(w, 8))) found.add("a named secret");
    }
    const h = HEADER_IN_TEXT.exec(line);
    if (h && words(h[2]).some((w) => secretish(w, 8))) found.add("a header in text");
  }
  return [...found];
}

// A zip the module refuses to build. The report route answers 409 with the message.
export class BundleRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "BundleRefused";
    this.refused = true;
  }
}

function secretFile(name) {
  const base = name.split("/").pop();
  return SECRET_NAME.some((re) => re.test(base));
}

function secretBody(text) {
  return SECRET_CONTENT.some((re) => re.test(text));
}

// foundry.toml may name an RPC and an explorer key. Keep the block number;
// replace every endpoint value so a provider key in the URL cannot leave with
// the bundle, and every explorer key (`key = …` under [etherscan], which the
// module cannot read as a secret name) with ${ETHERSCAN_API_KEY}.
function scrubFoundryToml(text) {
  let section = "";
  const lines = String(text).split("\n").map((line) => {
    const head = /^\s*\[+\s*([A-Za-z0-9_.-]+)/.exec(line);
    if (head) section = head[1].split(".")[0];
    if (/^\s*(?:eth_rpc_url|rpc_url)\s*=/.test(line) || (section === "rpc_endpoints" && /^\s*[A-Za-z0-9_-]+\s*=/.test(line))) {
      return line.replace(/=.*/, `= "${RPC_PLACEHOLDER}"`);
    }
    if (/^\s*etherscan_api_key\s*=/.test(line)) return line.replace(/=.*/, `= "${ETHERSCAN_PLACEHOLDER}"`);
    if (section === "etherscan") {
      return line.replace(/(\bkey\s*=\s*)(?:"[^"\n]*"|'[^'\n]*'|[^,}\s]+)/g, `$1"${ETHERSCAN_PLACEHOLDER}"`);
    }
    return line;
  });
  return bundleText(lines.join("\n"), { forge: true });
}

// A forge file as it goes into the record and the zip: redacted, then checked.
// Returns { text } or { reason } when the file has to be left out.
function forgeFileText(path, raw) {
  const text = path === "foundry.toml" ? scrubFoundryToml(raw) : bundleText(raw, { forge: true });
  const shapes = leakShapes(text);
  return shapes.length ? { reason: `holds ${shapes.join(" and ")} the redactor cannot mask` } : { text };
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
    const out = forgeFileText(rel, raw);
    if (out.reason) omitted.push({ path: rel, reason: out.reason });
    else files.push({ path: rel, text: out.text });
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

export const EVIDENCE_REFUSAL = "An evidence finding has no replay bundle yet. Its pinned snapshot holds raw files from the target, and no redaction layer strips secrets from them. The report's snapshotHash is the proof.";

// Why this finding gets no zip, or null when it gets one.
export function bundleRefusal({ finding, recorded } = {}) {
  const proof = recorded?.proof || finding?.proof || null;
  const replay = recorded?.replay || proof?.replay || null;
  const kind = replay?.kind || proof?.kind || finding?.proofKind || "forge";
  return kind === "evidence" ? EVIDENCE_REFUSAL : null;
}

function proofJson(proof, replay) {
  const body = bundleValue(proof || {});
  // The proof test is its own file in the zip; a copy that holds a shape the
  // module cannot mask is named, not kept.
  if (typeof body.testSource === "string" && leakShapes(body.testSource).length) {
    body.testSource = `left out: ${forgeFileText("test/AgentPoc.t.sol", body.testSource).reason}`;
  }
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

// No backslash, drive colon, or control character: Windows extractors read
// those as path syntax, and a newline would break SHA256SUMS.
function zipPath(name) {
  if (/[\\:\x00-\x1f\x7f]/.test(String(name))) return null;
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

// An http proof against a pack lab can run again: the lab image is built
// from the Touchstone repo, and the script and the oracle are what the engine
// ran. A live target cannot: it is someone else's service at a later time.
const LAB_IMAGES = { web: "touchstone/web-lab:dev", "ai-mcp": "touchstone/ai-mcp-lab:dev" };
const LAB_URL = /^http:\/\/origin:\d+\//;
const RERUN = new URL("./replay-http-rerun.mjs", import.meta.url);
const PROOF_HTTP = new URL("./proof-http.mjs", import.meta.url);

function labRerun({ pack, proof, script }) {
  const image = LAB_IMAGES[pack];
  const log = Array.isArray(proof?.log) ? proof.log : [];
  const oracle = typeof proof?.oracle?.name === "string" && /^[\w.-]{1,80}$/.test(proof.oracle.name) ? proof.oracle.name : null;
  if (!script) return { why: "the request script was not on the recorded finding" };
  if (!image) return { why: pack ? `the ${pack} pack has no lab image to rerun against` : "the record does not name the pack" };
  if (!oracle) return { why: "the record does not name the oracle" };
  if (!log.length || !log.every((e) => LAB_URL.test(String(e?.request?.url ?? "")))) {
    return { why: "the proof ran against a live target, not the pack lab, so there is no offline rerun" };
  }
  return { pack, image, oracle };
}

function httpReadme({ title, hasScript, rerun }) {
  const script = hasScript
    ? "The request script is `script.mjs`. A secret value in it was replaced with `[REDACTED]`."
    : "The request script was not on the recorded finding, so it is not in this folder.";
  const head = `# Replay this finding

**${title || "Finding"}** · HTTP oracle

${script} The recorded request and response transcript is \`transcript.json\`. The oracle verdict is \`proof.json\`. No provider key and no bearer token is in this folder.
`;
  if (!rerun.pack) {
    return `${head}
## No rerun

There is no command in this folder that reruns the proof: ${rerun.why}.
`;
  }
  return `${head}
The proof ran \`script.mjs\` against the ${rerun.pack} pack's lab (\`${rerun.image}\`), on two internal Docker networks behind a recording proxy, and the \`${rerun.oracle}\` oracle read the proxy's transcript. \`rerun.mjs\` does the same with \`proof-http.mjs\`, the engine's own lab code, copied here. The lab image and the oracle are built from the Touchstone repo, so the rerun takes the path to a Touchstone checkout.

## Prepare (once, online)

Run this in the Touchstone checkout:

\`\`\`sh
npm run build:labs -- ${rerun.pack} && docker pull node:20-slim
\`\`\`

## Rerun (offline)

Run this from this directory (Node 18 or later):

\`\`\`sh
sha256sum -c SHA256SUMS && \\
  node rerun.mjs <path-to-touchstone-checkout>
\`\`\`

The lab networks have no internet route. \`rerun.mjs\` writes the new transcript to \`replay-transcript.json\`. It exits 0 when the oracle passes, 1 when it does not, and 2 when it cannot check (no checkout path, the image is not built, or the oracle is gone).
`;
}

function pushFile(entries, name, text, { own = false } = {}) {
  const path = zipPath(name);
  if (!path || entries.some((e) => e.name === path)) return;
  if (!own) {
    const shapes = leakShapes(text);
    if (shapes.length) throw new BundleRefused(`No replay bundle: ${path} holds ${shapes.join(" and ")} that the redactor cannot mask, so the zip would leak it.`);
  }
  entries.push({ name: path, data: Buffer.from(String(text), "utf8") });
}

// Line 1 of every README. The normalized finding's stages.proven is the app's
// verdict; a raw record falls back to pocProved. Anything else is not proven.
function verdictLine({ finding, recorded }) {
  const proven = typeof finding?.stages?.proven === "boolean" ? finding.stages.proven : recorded?.pocProved === true;
  return proven
    ? "PROVEN: the engine's proof gate passed this finding when it was recorded.\n\n"
    : "NOT PROVEN: the engine did not prove this finding. These files are a lead, not a proof, and a passing replay here does not make it one.\n\n";
}

function forgeBundle({ finding, recorded, replay, proof }) {
  const title = bundleText(finding?.title || "Finding");
  // Records are redacted when written; the bundle redacts and checks again, so
  // a record written by an older scrubber gets today's rules.
  const omitted = [...(Array.isArray(replay?.omitted) ? replay.omitted : [])];
  const files = [];
  for (const f of Array.isArray(replay?.files) ? replay.files : []) {
    const out = forgeFileText(f.path, f.text);
    if (out.reason) omitted.push({ path: f.path, reason: out.reason });
    else files.push({ path: f.path, text: out.text });
  }
  let testSource = proof?.testSource || finding?.proof?.testSource || null;
  if (testSource && !files.some((f) => f.path.startsWith("test/"))) {
    const out = forgeFileText("test/AgentPoc.t.sol", testSource);
    if (out.reason) omitted.push({ path: "test/AgentPoc.t.sol", reason: out.reason });
    testSource = out.text ?? null;
  }
  replay = replay && { ...replay, omitted };
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
${omittedList(omitted)}`;
  const entries = [];
  pushFile(entries, "README.md", verdictLine({ finding, recorded }) + readme);
  pushFile(entries, "proof.json", proofJson(proof, replay && { ...replay, command: command && replaySteps(command), prepare }));
  pushFile(entries, "fork.json", JSON.stringify({ rpc: RPC_PLACEHOLDER, block: Number.isFinite(fork.block) ? fork.block : null, forked: Boolean(fork.forked) }, null, 2) + "\n");
  for (const f of files) pushFile(entries, f.path, f.text);
  if (!files.some((f) => f.path.startsWith("test/")) && testSource) pushFile(entries, "test/AgentPoc.t.sol", testSource);
  if (command) {
    const harm = { contract: replay?.contract || null, test: replay?.test || null, harm: bundleValue(proof?.harm ?? null), transfers: bundleValue(proof?.transfers ?? []) };
    pushFile(entries, "harm.json", JSON.stringify(harm, null, 2) + "\n");
    pushFile(entries, "check-harm.mjs", readFileSync(CHECK_HARM, "utf8"), { own: true });
    pushFile(entries, "SHA256SUMS", sha256Sums(entries), { own: true });
  }
  return zipStore(entries);
}

function httpBundle({ finding, recorded, proof }) {
  const raw = recorded?.script ?? finding?.script ?? null;
  const text = raw ? bundleText(raw) : null;
  const transcript = bundleValue(Array.isArray(proof?.log) ? proof.log : Array.isArray(proof?.exchanges) ? proof.exchanges : []);
  const rerun = labRerun({ pack: recorded?.pack ?? finding?.pack ?? null, proof, script: text });
  const entries = [];
  pushFile(entries, "README.md", verdictLine({ finding, recorded }) + httpReadme({ title: bundleText(finding?.title || "Finding"), hasScript: Boolean(text), rerun }));
  pushFile(entries, "proof.json", proofJson(proof, null));
  pushFile(entries, "transcript.json", JSON.stringify(transcript, null, 2) + "\n");
  if (text) pushFile(entries, "script.mjs", text.endsWith("\n") ? text : text + "\n");
  if (rerun.pack) {
    pushFile(entries, "rerun.json", JSON.stringify({ pack: rerun.pack, image: rerun.image, oracle: rerun.oracle }, null, 2) + "\n");
    pushFile(entries, "rerun.mjs", readFileSync(RERUN, "utf8"), { own: true });
    pushFile(entries, "proof-http.mjs", readFileSync(PROOF_HTTP, "utf8"), { own: true });
    pushFile(entries, "SHA256SUMS", sha256Sums(entries), { own: true });
  }
  return zipStore(entries);
}

// Zip bytes for one finding. `recorded` is the raw run row (replay snapshot,
// request script, proof). `finding` is the normalized finding the report uses.
// Either may be missing fields; the zip says what it could not include.
export function buildReplayBundle({ finding, recorded } = {}) {
  const refused = bundleRefusal({ finding, recorded });
  if (refused) throw new BundleRefused(refused);
  const proof = recorded?.proof || finding?.proof || null;
  const replay = recorded?.replay || proof?.replay || null;
  const kind = replay?.kind || proof?.kind || finding?.proofKind || "forge";
  if (kind === "http") return httpBundle({ finding, recorded, proof });
  return forgeBundle({ finding, recorded, replay, proof });
}
