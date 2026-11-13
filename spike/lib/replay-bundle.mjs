// A replayable export of one finding.
//
// The narrative report tells the story. This module is the part a judge can
// rerun. proveFindings (lib/record.mjs) calls snapshotForgeReplay while the
// workspace still exists; the caller deletes that directory after record.
// storeReplayFiles writes the snapshot's files to replay/<sha256>.json in the
// results folder, and the proof keeps only that hash, the counts, and the
// paths. loadReplayFiles reads them back for the bundle. buildReplayBundle turns that snapshot into a zip: the proof test, the scope
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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../../app/server/redact.mjs";
import { Mnemonic, wordlists } from "ethers";
import { pinnedSolc, warmFor } from "./sandbox.mjs";

const MAX_FILE = 1_500_000;
const MAX_TOTAL = 8_000_000;
const SKIP_DIRS = new Set(["node_modules", "out", "cache", "broadcast", "artifacts", "oracle", "coverage", "dist", "target"]);
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
const RPC_NAMES = "alchemy|infura|ankr|quiknode|quicknode|blastapi|chainstack|getblock|nodereal|drpc|tenderly|moralis|blockpi|pokt";
const RPC_HOST = new RegExp(`https?:\\/\\/[^\\s"'\`\\\\/]*(?:${RPC_NAMES})[^\\s"'\`\\\\/]*([^\\s"'\`\\\\]*)`, "gi");
const RPC_HOST_NAME = new RegExp(RPC_NAMES, "i");
const NAMED = /([A-Za-z][\w-]{0,63})["'`]?[ \t]*[:=][ \t]*["'`]([^"'`\r\n]{1,1024})["'`]/g;
const SECRET_NAME_END = /(?:api[\s_-]?key|apikey|secret|password|passwd|token|cookie|auth|authorization|private[\s_-]?key|privkey|mnemonic|credentials?|session)$/i;
const HEADER_IN_TEXT = /(?:^|[^\w-])(cookie|set-cookie|authorization|proxy-authorization|x-[\w-]*(?:token|key|secret|auth|session))[ \t]*:[ \t]*(.+)$/i;

// "=" splits too: in `session=[REDACTED]` the name is not the value.
const words = (s) => s.split(/[\s,;"'`=]+/).filter(Boolean);
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
      if (SECRET_NAME_END.test(m[1]) && !PLAIN.test(v) && redactorMasks(`${m[1]} = "${v}"`)) found.add("a named secret");
    }
    // The text was redacted already. The redactor judges the same name and
    // value again on a bare line: if it masks something there, the context in
    // the file hid a secret from it. Code like `"Bearer " + a.d.token` stays.
    const h = HEADER_IN_TEXT.exec(line);
    if (h && redactorMasks(`${h[1]}: ${h[2]}`)) found.add("a header in text");
  }
  if (hasMnemonic(text)) found.add("a mnemonic");
  return [...found];
}

// The redactor's own value judgement on a bare line (redact.mjs). The bundle
// writes no third secret detector for names and headers.
function redactorMasks(line) {
  return redactSecrets(line) !== line;
}

// A BIP39 phrase can be named without a keyword: its last word carries a
// checksum. A run of 12 or more English wordlist words is checked in every
// window of 12, 15, 18, 21 or 24 words. A run that fails every checksum is
// not a seed phrase.
const WORDLIST = wordlists.en;
function hasMnemonic(text) {
  let run = [];
  const check = () => {
    for (let i = 0; i + 12 <= run.length; i++) {
      for (const n of [12, 15, 18, 21, 24]) {
        if (i + n > run.length) break;
        if (Mnemonic.isValidMnemonic(run.slice(i, i + n).join(" "), WORDLIST)) return true;
      }
    }
    return false;
  };
  for (const w of String(text ?? "").split(/[^a-z]+/)) {
    if (w && WORDLIST.getWordIndex(w) >= 0) {
      run.push(w);
      continue;
    }
    if (w && check()) return true;
    if (w) run = [];
  }
  return check();
}

// Values the bundle cannot judge: each may be a secret or may be evidence (a
// transaction hash, a storage slot, an id in a URL). They are counted, never
// shown, and listed for the reader. A line with a key word or the word "aws"
// is not counted here: leakShapes names it, and the zip is refused or the file
// left out.
const HEX64_ALL = new RegExp(HEX64.source, "g");
const URL_PARTS = /https?:\/\/([^\s"'`\\/?#]+)([^\s"'`\\]*)/gi;
const LAB_HOST = /^origin(?::\d+)?$/;
const UNJUDGED_TEXT = {
  hex64: (n) => `${n} ${n === 1 ? "value" : "values"} of 64 hex characters that may be ${n === 1 ? "a key or a hash" : "keys or hashes"}`,
  aws40: (n) => `${n} ${n === 1 ? "token" : "tokens"} of 40 characters that may be ${n === 1 ? "an AWS secret key" : "AWS secret keys"}`,
  urlToken: (n) => `${n} URL ${n === 1 ? "part" : "parts"} that may be ${n === 1 ? "an access token" : "access tokens"}`,
};
// counts[shape] is a Set of SHA-256 hashes, so a value seen in two files
// counts once. Only the hash is kept, never the value.
export function unjudgedCounts(text, counts = {}) {
  const add = (k, v) => (counts[k] ??= new Set()).add(createHash("sha256").update(v).digest("hex"));
  for (const line of String(text ?? "").split(/\r?\n|\\n/)) {
    // A value right after "sha256:" is a digest by name (the pinned image).
    if (!KEY_WORD.test(line) && !KEY_CAMEL.test(line)) {
      for (const m of line.matchAll(HEX64_ALL)) if (!/sha256:$/i.test(line.slice(Math.max(0, m.index - 7), m.index))) add("hex64", m[0].replace(/^0x/, "").toLowerCase());
    }
    if (!AWS_WORD.test(line)) {
      for (const [t] of line.matchAll(AWS_SECRET)) {
        if (/[a-z]/.test(t) && /[A-Z]/.test(t) && /[0-9]/.test(t) && !/^[0-9a-fA-F]+$/.test(t)) add("aws40", t);
      }
    }
    for (const m of line.matchAll(URL_PARTS)) {
      if (LAB_HOST.test(m[1]) || RPC_HOST_NAME.test(m[1])) continue;
      for (const seg of m[2].split(/[/?#&=]/)) {
        if (seg.length >= 20 && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg) && !/^(?:\$\{|\[REDACTED|0x[0-9a-fA-F]+$)/.test(seg)) add("urlToken", seg);
      }
    }
  }
  return counts;
}
export function unjudgedList(counts) {
  return Object.keys(UNJUDGED_TEXT)
    .filter((k) => counts[k]?.size > 0)
    .map((k) => ({ shape: k, count: counts[k].size, text: UNJUDGED_TEXT[k](counts[k].size) }));
}
export const UNJUDGED_NOTE = "Check these before you share the bundle";

// A zip the module refuses to build. The report route answers 409 with the message.
export class BundleRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "BundleRefused";
    this.refused = true;
  }
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
// redact.mjs replaces a text over 64 KB whole with this mark. A file that
// came back as the mark is not code any more, so it is left out.
const CAP_MARK = /\[REDACTED: text of \d+ characters too long to check\]/;
export const OVER_CAP = "over 64 KB, so the redactor cannot check it";
function forgeFileText(path, raw) {
  const text = path === "foundry.toml" ? scrubFoundryToml(raw) : bundleText(raw, { forge: true });
  // An old record can hold the mark as its text: that is never code either.
  if (CAP_MARK.test(text)) return { reason: OVER_CAP };
  const shapes = leakShapes(text);
  return shapes.length ? { reason: `holds ${shapes.join(" and ")} the redactor cannot mask` } : { text };
}

// A path the redactor would mask, in whole or in one part, is not shipped:
// not as a zip entry name, not in a list, not in the record. Lists show this.
export const MASKED_PATH = "[REDACTED]";
export function pathMasked(rel) {
  const s = String(rel ?? "");
  return redactSecrets(s) !== s || s.split("/").some((part) => redactSecrets(part) !== part) || leakShapes(s).length > 0;
}

// Libraries the engine itself puts into a workspace: sandbox.mjs copies a lab's
// lib/ (or lab/vault-reentrancy's forge-std into a brief workspace), and the
// keys proofs copy the keys lab's lib/. Today these are forge-std (every lab)
// and chimera (lab/vault-shares). A workspace file that is byte-identical to
// the engine's copy at the same path is that public library: it is kept as it
// is, without redaction, and the record keeps only its SHA-256.
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
let vendoredIndex = null;
function engineLibRoots() {
  const roots = [];
  for (const [base, sub] of [[join(REPO_ROOT, "lab"), []], [join(REPO_ROOT, "spike", "packs"), ["lab"]]]) {
    let dirs = [];
    try { dirs = readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const lib = join(base, d.name, ...sub, "lib");
      if (existsSync(lib)) roots.push(lib);
    }
  }
  return roots;
}
function vendored() {
  if (vendoredIndex) return vendoredIndex;
  const index = new Map();
  for (const root of engineLibRoots()) {
    const walk = (dir, parts) => {
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const abs = join(dir, e.name);
        if (e.isDirectory()) { walk(abs, [...parts, e.name]); continue; }
        if (!e.isFile() || !parts.length) continue;
        const rel = ["lib", ...parts, e.name].join("/");
        const sha256 = createHash("sha256").update(readFileSync(abs)).digest("hex");
        if (!index.has(rel)) index.set(rel, new Map());
        index.get(rel).set(sha256, { lib: parts[0], abs });
      }
    };
    walk(root, []);
  }
  vendoredIndex = index;
  return index;
}
// { lib, sha256 } when these bytes are the engine's copy of that path.
export function vendoredFile(rel, buf) {
  const byHash = vendored().get(rel);
  if (!byHash) return null;
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const hit = byHash.get(sha256);
  return hit ? { lib: hit.lib, sha256 } : null;
}
// The engine's bytes for a vendored file, or null when it no longer ships them.
function engineVendored(rel, sha256) {
  const hit = vendored().get(rel)?.get(sha256);
  try {
    return hit ? readFileSync(hit.abs) : null;
  } catch {
    return null;
  }
}
export function vendoredLibs() {
  return [...new Set([...vendored().values()].flatMap((m) => [...m.values()].map((v) => v.lib)))].sort();
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
// Every file or folder the walk does not take, with the reason. A skip can
// matter only when a kept source imports into it; importGaps finds those and
// lists them under "Left out", so the bundle then has no command:
// - a symbolic link (file or folder): not followed;
// - a hidden file or folder (a name that starts with "."), a skipped folder
//   (SKIP_DIRS: node_modules, out, cache, …), a library's own test folder;
// - a path that is not a regular file (a socket, a device).
// A file that keepPath does not take (not .sol, not the top foundry.toml or
// remappings.txt) is not source; a proof that reads such a file at run time is
// caught by runtimeReads. Read errors, binary content, the size limits, a
// masked path, a secret and the cap mark are left out by snapshotForgeReplay.
function collectFiles(root) {
  const found = [];
  const skipped = new Map();
  const skippedDirs = [];
  const walk = (dir, parts) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch {
      if (parts.length) skippedDirs.push({ dir: parts.join("/"), reason: "a folder that could not be read" });
      return;
    }
    for (const e of entries) {
      const rel = [...parts, e.name].join("/");
      if (e.isSymbolicLink()) {
        skipped.set(rel, "a symbolic link; not followed");
        skippedDirs.push({ dir: rel, reason: "a symbolic link; not followed" });
        continue;
      }
      if (e.isDirectory()) {
        if (e.name.startsWith(".")) skippedDirs.push({ dir: rel, reason: "a hidden folder; not included" });
        else if (SKIP_DIRS.has(e.name)) skippedDirs.push({ dir: rel, reason: `${e.name}/ is not included` });
        else if ((e.name === "test" || e.name === "tests") && parts.includes("lib")) skippedDirs.push({ dir: rel, reason: "a library's test folder is not included" });
        else walk(join(dir, e.name), [...parts, e.name]);
        continue;
      }
      if (!e.isFile()) {
        skipped.set(rel, "not a regular file");
        continue;
      }
      if (e.name.startsWith(".")) {
        skipped.set(rel, "a hidden file; not included");
        continue;
      }
      if (keepPath(rel)) found.push(rel);
    }
  };
  walk(root, []);
  found.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  return { paths: found, skipped, skippedDirs };
}

// The Solidity imports of one text. Comments are removed first, so a
// commented-out import is not read.
const IMPORT = /\bimport\s+(?:[^;"']*?\bfrom\s+)?["']([^"']+)["']/g;
// The imports of one text, matched on the comment-stripped text AND on the raw
// text. A string like "/*" cannot hide an import from the stripped pass; a
// false hit from import-like text inside a string becomes a gap (no command),
// which fails closed.
function importsOf(text) {
  const raw = String(text ?? "");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
  return [...new Set([...code.matchAll(IMPORT), ...raw.matchAll(IMPORT)].map((m) => m[1]))];
}
function normPath(p) {
  const out = [];
  for (const part of String(p).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}
// Forge's resolution, as far as the folder needs it: a relative path from the
// importing file; else the explicit remappings (remappings.txt, foundry.toml),
// longest prefix first; else the automatic ones (lib/<name>/src/ or
// lib/<name>/ for each library); else the path from the project root or from
// each libs folder.
function remappingsOf(texts, known) {
  const toml = texts.get("foundry.toml") || "";
  const quoted = (body) => [...String(body).matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  const libs = (() => {
    const m = /^\s*libs\s*=\s*\[([^\]]*)\]/m.exec(toml);
    const list = m ? quoted(m[1]) : [];
    return list.length ? list.map((l) => normPath(l)).filter(Boolean) : ["lib"];
  })();
  const lines = [...String(texts.get("remappings.txt") || "").split("\n"), ...((/^\s*remappings\s*=\s*\[([\s\S]*?)\]/m.exec(toml) || [])[1] ? quoted(/^\s*remappings\s*=\s*\[([\s\S]*?)\]/m.exec(toml)[1]) : [])];
  const explicit = [];
  for (const raw of lines) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (!line || line.startsWith("#") || eq < 1) continue;
    let prefix = line.slice(0, eq);
    const colon = prefix.indexOf(":");
    if (colon >= 0) prefix = prefix.slice(colon + 1);
    explicit.push({ prefix, target: line.slice(eq + 1) });
  }
  const auto = [];
  for (const lib of libs) {
    const names = new Set([...known].filter((p) => p.startsWith(`${lib}/`)).map((p) => p.slice(lib.length + 1).split("/")[0]));
    for (const name of names) {
      const src = [...known].some((p) => p.startsWith(`${lib}/${name}/src/`));
      auto.push({ prefix: `${name}/`, target: src ? `${lib}/${name}/src/` : `${lib}/${name}/` });
    }
  }
  const byLength = (a, b) => b.prefix.length - a.prefix.length;
  return { explicit: explicit.sort(byLength), auto: auto.sort(byLength), libs };
}
function importCandidates(from, spec, maps) {
  if (spec.startsWith("./") || spec.startsWith("../")) return [normPath(`${from.split("/").slice(0, -1).join("/")}/${spec}`)].filter(Boolean);
  const out = [];
  const hit = maps.explicit.find((r) => spec.startsWith(r.prefix)) || maps.auto.find((r) => spec.startsWith(r.prefix));
  if (hit) out.push(normPath(hit.target + spec.slice(hit.prefix.length)));
  out.push(normPath(spec));
  for (const lib of maps.libs) out.push(normPath(`${lib}/${spec}`));
  return out.filter(Boolean);
}

// The imports of the kept sources that do not resolve to a kept file, as
// "Left out" entries. `skipped` and `skippedDirs` (from collectFiles) give the
// reason when the walk skipped the target; else it is not in the folder.
export function importGaps(texts, { skipped = new Map(), skippedDirs = [], omitted = [] } = {}) {
  const known = new Set(texts.keys());
  for (const p of skipped.keys()) known.add(p);
  const maps = remappingsOf(texts, known);
  const listed = new Set(omitted.map((o) => o?.path).filter(Boolean));
  const gaps = [];
  for (const [from, text] of texts) {
    if (!from.endsWith(".sol")) continue;
    for (const spec of importsOf(text)) {
      const cands = importCandidates(from, spec, maps);
      if (cands.some((c) => texts.has(c))) continue;
      const why = (c) => skipped.get(c) ?? skippedDirs.find((d) => c === d.dir || c.startsWith(`${d.dir}/`))?.reason ?? null;
      const target = cands.find((c) => why(c)) ?? cands[0] ?? spec;
      const shown = pathMasked(target) ? MASKED_PATH : target;
      if (listed.has(target) || listed.has(shown)) continue;
      listed.add(target);
      gaps.push({ path: shown, reason: `imported by ${from}, but ${why(target) ?? "it is not in this folder"}` });
    }
  }
  return gaps;
}

// A proof that reads a file or runs a program at run time needs more than the
// .sol and config files this folder holds. Engine library files are not
// checked: they define these helpers, and a proof that only imports them
// reads nothing.
// The file-system and program cheatcodes, taken from the Filesystem section of
// the vendored forge-std Vm.sol (between "======== Filesystem ========" and the
// next "========" marker). ffi, tryFfi and the artifact helpers live in that
// section, so the set matches the pinned forge-std. A call to any of these on
// ANY receiver (vm., cheats., hevm., a renamed Vm variable) means the proof
// needs more than this folder. The artifact helpers (getCode and the like) are
// allowed only for an `X.sol` or `X.sol:Name` argument, which forge resolves
// from the compiled out/ with no file read; any other argument, or a
// non-literal one, drops the command.
const ARTIFACT_CHEATS = new Set(["getCode", "getDeployedCode", "deployCode", "deployCodeTo"]);
let fileCheatSet = null;
function fileCheats() {
  if (fileCheatSet) return fileCheatSet;
  let names = [];
  try {
    const entry = [...(vendored().get("lib/forge-std/src/Vm.sol")?.values() ?? [])][0];
    const src = entry ? readFileSync(entry.abs, "utf8") : "";
    const at = src.indexOf("======== Filesystem ========");
    const end = src.indexOf("========", at + 30);
    const section = at >= 0 ? src.slice(at, end >= 0 ? end : undefined) : "";
    names = [...section.matchAll(/\bfunction\s+([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]);
  } catch {
    names = [];
  }
  // A backstop if the vendored Vm.sol is not readable, so the rule never opens.
  const fallback = ["readFile", "readFileBinary", "readLine", "readDir", "readLink", "writeFile", "writeFileBinary", "writeLine", "closeFile", "copyFile", "createDir", "removeDir", "removeFile", "exists", "isFile", "isDir", "fsMetadata", "projectRoot", "prompt", "promptSecret", "promptSecretUint", "promptUint", "promptAddress", "ffi", "tryFfi", "getCode", "getDeployedCode", "deployCode", "deployCodeTo", "getArtifactPathByCode", "getArtifactPathByDeployedCode"];
  fileCheatSet = new Set(names.length ? names : fallback);
  return fileCheatSet;
}
function importsFree(text) {
  return String(text ?? "").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
}
// The first string literal that follows "(", or null when the first argument
// is not a plain string literal.
function firstStringArg(afterParen) {
  const m = /^\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/.exec(afterParen);
  return m ? m[2] : null;
}
const ARTIFACT_NAME = /^[^"'\s]+\.sol(?::[A-Za-z0-9_$]+)?$/;
// Each kept source that calls a file-system or ffi cheatcode, as a reason. The
// raw text and the comment-stripped text are both scanned, so a call hidden
// after a "/*" inside a string is still caught. A vendored library file defines
// these cheatcodes but does not call them, so it is not scanned.
export function runtimeReads(texts, vendoredPaths = new Set()) {
  const names = fileCheats();
  const CALL = new RegExp("\\.\\s*(" + [...names].join("|") + ")\\s*\\(([\\s\\S]{0,200})", "g");
  const out = new Set();
  for (const [path, text] of texts) {
    if (!path.endsWith(".sol") || vendoredPaths.has(path)) continue;
    for (const body of [String(text ?? ""), importsFree(text)]) {
      CALL.lastIndex = 0;
      let m;
      while ((m = CALL.exec(body))) {
        const name = m[1];
        if (ARTIFACT_CHEATS.has(name)) {
          const arg = firstStringArg(m[2]);
          if (arg !== null && ARTIFACT_NAME.test(arg)) continue; // X.sol[:Name]: from out/, no file
          out.add(`${path} calls ${name}() on a path, and this folder holds only the .sol and config files`);
        } else {
          out.add(`${path} calls ${name}(), a cheatcode that reads the disk or runs a program`);
        }
      }
    }
  }
  return [...out];
}

// foundry.toml grants that let a proof reach outside the .sol and config files:
// file-system access (fs_permissions) or program execution (ffi = true), in any
// profile. forge itself denies these without the grant, so the grant is the
// signal that the proof may need more than this folder.
export function tomlGrant(texts) {
  const toml = texts.get("foundry.toml") || "";
  if (/^\s*fs_permissions\s*=/m.test(toml) || /\bfs_permissions\s*=\s*\[/.test(toml)) return "foundry.toml grants file-system access (fs_permissions), so the proof may read files this folder does not hold";
  if (/\bffi\s*=\s*true\b/.test(toml)) return "foundry.toml enables program execution (ffi = true)";
  return null;
}

// The one place that decides whether the bundle keeps its replay command. It
// keeps the command only when EVERY condition holds; anything else means no
// command, line 1 says why, and the files still ship. (A deny list let three
// shapes through across reviews, so this is a positive list.)
//   1. the folder holds foundry.toml and a proof test;
//   2. no file was left out (omitted), which includes every import of every
//      kept source resolving inside the folder (importGaps);
//   3. foundry.toml grants no file-system access and no program execution;
//   4. no kept source calls a forge-std file-system or ffi cheatcode (or an
//      artifact cheatcode on a path that is not X.sol[:Name]).
export function rerunBlock({ haveProject, filesLost, omitted, reads, grant }) {
  if (!haveProject) return filesLost ? `the replay files of this run are gone (${filesLost})` : "it does not hold both foundry.toml and a proof test";
  if (omitted.length) return `${omitted.length} ${omitted.length === 1 ? "file was" : "files were"} left out (see "Left out")`;
  if (grant) return grant;
  if (reads.length) return reads.join("; ");
  return null;
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
  const { paths, skipped, skippedDirs } = collectFiles(ws);
  // The raw text of each kept source, for the import check only. It is not stored.
  const texts = new Map();
  const files = [];
  const omitted = [];
  let total = 0;
  let capped = 0;
  for (const rel of paths) {
    if (pathMasked(rel)) {
      omitted.push({ path: MASKED_PATH, reason: "its path holds a value the redactor masks" });
      continue;
    }
    let buf;
    try {
      buf = readFileSync(join(ws, rel));
    } catch {
      omitted.push({ path: rel, reason: "a file that could not be read" });
      continue;
    }
    const lib = vendoredFile(rel, buf);
    if (lib) {
      total += buf.length;
      files.push({ path: rel, vendored: lib });
      texts.set(rel, buf.toString("utf8"));
      continue;
    }
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
    else {
      files.push({ path: rel, text: out.text });
      texts.set(rel, raw);
    }
  }
  if (capped) omitted.push({ path: "", reason: `bundle size cap; ${capped} file${capped === 1 ? "" : "s"} left out` });
  // A skip that a kept source imports into is a file the build needs.
  omitted.push(...importGaps(texts, { skipped, skippedDirs, omitted }));
  const reads = runtimeReads(texts, new Set(files.filter((f) => f.vendored).map((f) => f.path)));
  const grant = tomlGrant(texts);
  let toml = "";
  try {
    if (paths.includes("foundry.toml")) toml = readFileSync(join(ws, "foundry.toml"), "utf8");
  } catch {
    toml = "";
  }
  const sources = files.filter((f) => f.path.endsWith(".sol") && typeof f.text === "string").map((f) => f.text).join("\n");
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
    ...(reads.length ? { runtimeReads: reads } : {}),
  };
  replay.prepare = prepareCommand(replay);
  const haveProject = files.some((f) => f.path === "foundry.toml") && files.some((f) => f.path.startsWith("test/"));
  // One rule decides the command, here and at bundle time.
  replay.command = rerunBlock({ haveProject, filesLost: null, omitted, reads, grant }) ? null : forgeCommand(replay);
  return replay;
}

// The replay files leave the run record. Each forge finding held about 820 KB
// of source, and every reader of the run records parsed it. The files go to
// replay/<sha256>.json next to the run records, named by the SHA-256 of that
// file's bytes, so two findings with the same sources share one file. The text
// is the redacted text from snapshotForgeReplay; the bundle redacts it again.
export const REPLAY_FILES_VERSION = 3;
const STORE_HASH = /^[a-f0-9]{64}$/;
// A test that sets no results folder must not write the real one: under
// `node --test` (NODE_TEST_CONTEXT) or `bun test` (NODE_ENV=test) the store
// goes to a folder of its own in the temp folder, removed when the process ends.
let testStore = null;
function underTest() {
  return Boolean(process.env.NODE_TEST_CONTEXT) || (Boolean(process.versions.bun) && process.env.NODE_ENV === "test");
}
export function replayStoreDir() {
  const results = process.env.TOUCHSTONE_RESULTS_DIR || process.env.AGENT_RESULTS_DIR;
  if (results) return join(results, "replay");
  if (underTest()) {
    if (!testStore) {
      testStore = join(tmpdir(), `touchstone-replay-test-${process.pid}`);
      const dir = testStore;
      process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    }
    return testStore;
  }
  return join(fileURLToPath(new URL("../results/agent/", import.meta.url)), "replay");
}

// The replay as the run record keeps it: no file text. A store that fails is
// named on the replay, and the bundle says the files are gone.
// A vendored library file is kept as { path, vendored: { lib, sha256 } } in
// the replay file, and its bytes once in replay/lib/<sha256>, shared by every
// record. So a record stays replayable when the engine's own copy changes.
export function storeReplayFiles(replay, dir = replayStoreDir()) {
  if (!replay || !Array.isArray(replay.files)) return replay;
  const { files, ...rest } = replay;
  const body = JSON.stringify({ version: 1, files: files.map((f) => (f.vendored ? { path: f.path, vendored: f.vendored } : { path: f.path, text: f.text })) });
  const sha256 = createHash("sha256").update(body).digest("hex");
  const kept = { ...rest, version: REPLAY_FILES_VERSION, paths: files.map((f) => f.path) };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of files) {
      if (!f.vendored) continue;
      const blob = join(dir, "lib", f.vendored.sha256);
      if (existsSync(blob)) continue;
      const bytes = engineVendored(f.path, f.vendored.sha256);
      if (!bytes) throw Object.assign(new Error("vendored"), { code: "the engine no longer ships a vendored file" });
      mkdirSync(join(dir, "lib"), { recursive: true, mode: 0o700 });
      writeFileSync(`${blob}.tmp`, bytes, { mode: 0o600 });
      renameSync(`${blob}.tmp`, blob);
    }
    const file = join(dir, `${sha256}.json`);
    if (!existsSync(file)) {
      writeFileSync(`${file}.tmp`, body, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    }
    return { ...kept, store: { sha256, fileCount: files.length, bytes: Buffer.byteLength(body) } };
  } catch (err) {
    return { ...kept, store: null, filesLost: `the replay files could not be stored (${String(err?.code || err?.message || err).slice(0, 80)})` };
  }
}

// After a run delete: remove each replay file that no run record in
// resultsDir names any more, then each vendored blob that no kept replay
// file names. A record that cannot be read stops the prune: it may be one
// that is being written, and its files must stay. Returns the counts.
const RECORD = /^run-.+\.json$/;
const HASH_FIELD = /"sha256"\s*:\s*"([a-f0-9]{64})"/g;
export function pruneReplayStore(resultsDir) {
  const dir = join(resultsDir, "replay");
  if (!existsSync(dir)) return { removed: 0, blobs: 0 };
  const named = new Set();
  try {
    for (const f of readdirSync(resultsDir)) {
      if (!RECORD.test(f)) continue;
      const text = readFileSync(join(resultsDir, f), "utf8");
      JSON.parse(text);
      for (const m of text.matchAll(HASH_FIELD)) named.add(m[1]);
    }
  } catch {
    return { removed: 0, blobs: 0, stopped: "a run record could not be read" };
  }
  let removed = 0;
  const libs = new Set();
  for (const f of readdirSync(dir)) {
    const m = /^([a-f0-9]{64})\.json$/.exec(f);
    if (!m) continue;
    if (!named.has(m[1])) {
      rmSync(join(dir, f), { force: true });
      removed++;
      continue;
    }
    try {
      for (const v of readFileSync(join(dir, f), "utf8").matchAll(HASH_FIELD)) libs.add(v[1]);
    } catch {
      return { removed, blobs: 0, stopped: "a replay file could not be read" };
    }
  }
  let blobs = 0;
  const lib = join(dir, "lib");
  if (existsSync(lib)) {
    for (const f of readdirSync(lib)) {
      if (STORE_HASH.test(f) && !libs.has(f)) {
        rmSync(join(lib, f), { force: true });
        blobs++;
      }
    }
  }
  return { removed, blobs };
}

// The replay with its files back. An old record kept the text inline: it is
// returned as it is. A store file that is gone or does not match its hash
// gives no files and a reason; the bundle names it and has no command.
export function loadReplayFiles(replay, dir = replayStoreDir()) {
  if (!replay || Array.isArray(replay.files) || replay.kind === "evidence") return replay;
  if (replay.filesLost) return { ...replay, files: [] };
  const sha256 = replay.store?.sha256;
  if (typeof sha256 !== "string" || !STORE_HASH.test(sha256)) return replay.store === undefined ? replay : { ...replay, files: [], filesLost: "the record names no replay file" };
  let bytes;
  try {
    bytes = readFileSync(join(dir, `${sha256}.json`));
  } catch {
    return { ...replay, files: [], filesLost: "the replay file is no longer in the results folder" };
  }
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) return { ...replay, files: [], filesLost: "the replay file does not match the hash in the record" };
  try {
    const files = JSON.parse(bytes.toString("utf8")).files;
    const ok = (f) => typeof f?.path === "string" && (typeof f?.text === "string" || (typeof f?.vendored?.lib === "string" && STORE_HASH.test(String(f?.vendored?.sha256))));
    if (!Array.isArray(files) || !files.every(ok)) throw new Error("bad shape");
    return { ...replay, files: files.map((f) => (f.vendored ? { ...f, text: vendoredText(f, dir) } : f)) };
  } catch {
    return { ...replay, files: [], filesLost: "the replay file is not readable" };
  }
}

// The text of a vendored file: the store's copy, else the engine's, each
// checked against the hash. Null when neither holds those bytes.
function vendoredText(f, dir = null) {
  const sha256 = f?.vendored?.sha256;
  if (!STORE_HASH.test(String(sha256))) return null;
  const same = (b) => b && createHash("sha256").update(b).digest("hex") === sha256;
  let bytes = null;
  try { if (dir) bytes = readFileSync(join(dir, "lib", sha256)); } catch { bytes = null; }
  if (!same(bytes)) bytes = engineVendored(f.path, sha256);
  return same(bytes) ? bytes.toString("utf8") : null;
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
    snapshotFiles: names.slice(0, MAX_LISTED).map((n) => (pathMasked(n) ? MASKED_PATH : n)),
    snapshotFileCount: names.length,
  };
}

export const EVIDENCE_REFUSAL = "An evidence finding has no replay bundle yet. Its pinned snapshot holds raw files from the target, and no redaction layer strips secrets from them. The report's snapshotHash is the proof.";

// Why this finding gets no zip, or null when it gets one.
export const NOT_PROVEN_REFUSAL = "This finding is not proven by its replay, so it has no replay bundle: a bundle of a lead could be shared as if it were proof.";
// Proven: the normalized finding's stages.proven; a raw record's pocProved.
export function provenFinding({ finding, recorded } = {}) {
  return typeof finding?.stages?.proven === "boolean" ? finding.stages.proven : recorded?.pocProved === true;
}
export function bundleRefusal({ finding, recorded } = {}) {
  const proof = recorded?.proof || finding?.proof || null;
  const replay = recorded?.replay || proof?.replay || null;
  const kind = replay?.kind || proof?.kind || finding?.proofKind || "forge";
  if (kind === "evidence") return EVIDENCE_REFUSAL;
  return provenFinding({ finding, recorded }) ? null : NOT_PROVEN_REFUSAL;
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

function vendoredNote(libs) {
  if (!libs?.length) return "";
  return ` Vendored library files (${libs.map((l) => `\`lib/${l}\``).join(", ")}) are included unchanged: each one is byte-identical (SHA-256) to the copy the engine installs, so it is public library code and is not redacted. A library's own public sample values stay as the library ships them, such as the sample RPC keys in forge-std's \`StdChains.sol\`.`;
}

function forgeReadme({ title, replay, command, prepare, fork, harm, libs = [], noRerun = null }) {
  const block = Number.isFinite(fork?.block) ? String(fork.block) : "null";
  if (!command) {
    return `# Replay this finding

**${title || "Finding"}** · Foundry

There is no command that can rerun the proof from this folder: ${noRerun || "the snapshot is not complete"}. The files that are here are the recorded ones. \`proof.json\` is the recorded verdict. \`fork.json\` records \`rpc\` as ${rpcShown} and \`block\` as ${block}.${vendoredNote(libs)}

No provider key and no bearer token from the run is included.
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

The proof test, the scope sources, and the Foundry config are in this folder. \`proof.json\` is the recorded verdict. Dependency test suites under \`lib/\` are not included: the proof does not import them, and some ship sample provider keys.${vendoredNote(libs)}

${forkNote} ${solc} ${image} No provider key and no bearer token from the run is in this folder.

The replay has three steps. \`sha256sum -c SHA256SUMS\` fails if any file in this folder, the proof test included, differs from what was recorded. Forge then reruns the named test and writes its JSON trace to \`replay.json\`. \`node check-harm.mjs\` (Node 18 or later) reads that trace and checks it against \`harm.json\`, the harm the engine recorded. It exits 0 when the test passed and the victim lost the recorded wei, 1 when not, and 2 when it cannot check. ${harmCheck(harm).long}
${prep}${fence(command && replaySteps(command), "Replay (offline)")}${omittedList(replay?.omitted)}`;
}

// An http proof against a pack lab can run again: the lab image is built
// from the Touchstone repo, and the script and the oracle are what the engine
// ran. A live target cannot: it is someone else's service at a later time.
const LAB_IMAGES = { web: "touchstone/web-lab:dev", "ai-mcp": "touchstone/ai-mcp-lab:dev" };
const LAB_URL = /^http:\/\/origin:\d+\//;
const RERUN = new URL("./replay-http-rerun.mjs", import.meta.url);
// The engine files a rerun loads from the checkout. rerun.json keeps their
// hashes, so the rerun can say when the checkout is not the code that proved it.
const ENGINE_FILES = (pack) => ["spike/lib/proof-http.mjs", "spike/lib/lab-net.mjs", `spike/packs/${pack}/pack.mjs`];
const REPO = new URL("../../", import.meta.url);
function engineHashes(pack) {
  const out = {};
  for (const rel of ENGINE_FILES(pack)) {
    try {
      out[rel] = createHash("sha256").update(readFileSync(new URL(rel, REPO))).digest("hex");
    } catch {
      out[rel] = null;
    }
  }
  return out;
}

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

function httpReadme({ title, hasScript, scriptOverCap = false, rerun }) {
  const script = hasScript
    ? "The request script is `script.mjs`. A secret value in it was replaced with `[REDACTED]`."
    : scriptOverCap
      ? `The request script is ${OVER_CAP}, so it is left out of this folder.`
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
The proof ran \`script.mjs\` against the ${rerun.pack} pack's lab (\`${rerun.image}\`), on two internal Docker networks behind a recording proxy, and the \`${rerun.oracle}\` oracle read the proxy's transcript. \`rerun.mjs\` does the same with the engine's own lab code (\`spike/lib/proof-http.mjs\`) and the pack's oracle, both loaded from a Touchstone checkout, so the rerun takes the path to one. \`rerun.json\` holds the SHA-256 of each engine file that made the proof; the rerun says so when the checkout differs.

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
  entries.push({ name: path, data: Buffer.from(String(text), "utf8"), own });
}

// The README goes first, with the list of values the bundle could not judge.
// The count runs over every file the zip takes from the record, the README
// head included; the engine's own files are not counted.
function finish(entries, head) {
  const counts = {};
  unjudgedCounts(head, counts);
  for (const e of entries) if (!e.own) unjudgedCounts(e.data.toString("utf8"), counts);
  const unjudged = unjudgedList(counts);
  const section = unjudged.length
    ? `\n## ${UNJUDGED_NOTE}\n\nThe redactor could not judge these values. Each one may be a secret, or it may be evidence (a transaction hash, a storage slot, an id). They are counted here, not shown:\n\n${unjudged.map((u) => `- ${u.text}`).join("\n")}\n`
    : `\n## ${UNJUDGED_NOTE}\n\nThe bundle found no value it could not judge: no 64-hex value, no 40-character token, and no long URL part outside a known provider.\n`;
  const readme = [];
  pushFile(readme, "README.md", head.endsWith("\n") ? head + section : `${head}\n${section}`);
  return { zip: zipStore([...readme, ...entries]), unjudged };
}

// What check-harm.mjs re-checks for this finding's harm, in the words the
// README uses. It reads the forge JSON trace, so it sees ETH moved by calls.
// The gate reads a token drain and a control takeover from the replay's
// storage writes (lib/control-trace.mjs), and that reader is not in the zip.
function harmCheck(harm) {
  const not = (what) => ({
    short: `The harm (${what}) is NOT re-checked by this folder.`,
    long: `This finding's harm is ${what}. The engine's gate read it from the replay's storage writes (\`lib/control-trace.mjs\`), and this folder does not hold that reader, so \`check-harm.mjs\` exits 2 for it. A passing replay here shows that the test still passes, not that the harm still happens.`,
  });
  if (!harm || harm.ok !== true) return { short: "The record holds no proven harm, so nothing is re-checked.", long: "The record holds no proven harm, so `check-harm.mjs` has nothing to compare and exits 2." };
  if (harm.kind === "funds" && !harm.asset) return { short: "The harm (an ETH drain) is re-checked by `check-harm.mjs`.", long: "This finding's harm is an ETH drain, and `check-harm.mjs` re-checks it: the victim must lose the recorded wei in the replay trace." };
  if (harm.kind === "funds" && harm.asset === "token") return not("a token drain");
  if (harm.kind === "control") return not("a control takeover: a write to an owner, admin, or implementation slot");
  return not(`of the kind "${String(harm.kind).replace(/[^\w -]/g, "").slice(0, 40)}"`);
}

// Line 1 of every README. The normalized finding's stages.proven is the app's
// verdict; a raw record falls back to pocProved. Anything else is not proven.
// bundleRefusal lets only a proven finding through, so line 1 starts PROVEN.
// It goes on to say whether this folder can rerun the proof.
function verdictLine(rest = "") {
  return `PROVEN: the engine's proof gate passed this finding when it was recorded.${rest ? ` ${rest}` : ""}\n\n`;
}

function forgeBundle({ finding, recorded, replay, proof }) {
  const title = bundleText(finding?.title || "Finding");
  // Records are redacted when written; the bundle redacts and checks again, so
  // a record written by an older scrubber gets today's rules. A vendored
  // library file is shipped as the engine's bytes, after a hash check.
  const omitted = [...(Array.isArray(replay?.omitted) ? replay.omitted : [])].map((o) => (o?.path && pathMasked(o.path) ? { ...o, path: MASKED_PATH } : o));
  const files = [];
  const libs = [];
  for (const f of Array.isArray(replay?.files) ? replay.files : []) {
    if (pathMasked(f.path)) {
      omitted.push({ path: MASKED_PATH, reason: "its path holds a value the redactor masks" });
      continue;
    }
    // A record's word that a file is vendored is not proof: the engine's own
    // index must hold this path with this hash. Else it is a normal file.
    const engineKnows = f.vendored && vendored().get(f.path)?.has(f.vendored.sha256);
    if (engineKnows) {
      const bytes = engineVendored(f.path, f.vendored.sha256);
      if (!bytes) {
        omitted.push({ path: f.path, reason: `a ${f.vendored.lib} file that the engine no longer holds` });
        continue;
      }
      files.push({ path: f.path, text: bytes.toString("utf8"), vendored: true });
      if (!libs.includes(f.vendored.lib)) libs.push(f.vendored.lib);
      continue;
    }
    const raw = f.vendored ? (typeof f.text === "string" ? f.text : vendoredText(f)) : f.text;
    if (typeof raw !== "string") {
      omitted.push({ path: f.path, reason: f.vendored ? `a ${f.vendored.lib} file that neither the record nor the engine holds any more` : "a file with no text in the record" });
      continue;
    }
    const out = forgeFileText(f.path, raw);
    if (out.reason) omitted.push({ path: f.path, reason: out.reason });
    else files.push({ path: f.path, text: out.text });
  }
  let testSource = proof?.testSource || finding?.proof?.testSource || null;
  if (testSource && !files.some((f) => f.path.startsWith("test/"))) {
    const out = forgeFileText("test/AgentPoc.t.sol", testSource);
    if (out.reason) omitted.push({ path: "test/AgentPoc.t.sol", reason: out.reason });
    testSource = out.text ?? null;
  }
  // The build must find every import in this folder. A record written before
  // this check, or one that lost a file, is checked here again.
  const texts = new Map(files.map((f) => [f.path, f.text]));
  if (testSource && !texts.has("test/AgentPoc.t.sol") && !files.some((f) => f.path.startsWith("test/"))) texts.set("test/AgentPoc.t.sol", testSource);
  omitted.push(...importGaps(texts, { omitted }));
  const reads = runtimeReads(texts, new Set(files.filter((f) => f.vendored).map((f) => f.path)));
  const grant = tomlGrant(texts);
  replay = replay && { ...replay, omitted };
  const haveProject = files.some((f) => f.path === "foundry.toml") && files.some((f) => f.path.startsWith("test/"));
  // A file the proof may need is not here: the replay would not compile, so
  // the bundle has no command and says why on line 1.
  const noRerun = rerunBlock({ haveProject, filesLost: replay?.filesLost, omitted, reads, grant });
  const fork = replay?.fork || { rpc: RPC_PLACEHOLDER, block: null, forked: false };
  // Rebuild the command from the recorded fields, so a record written before
  // the offline command still gets one.
  const command = noRerun ? null : forgeCommand({ ...replay, fork });
  const prepare = noRerun ? null : prepareCommand(replay);
  const harm = proof?.harm ?? null;
  const readme = files.length
    ? forgeReadme({ title, replay, command, prepare, fork, harm, libs, noRerun })
    : `# Replay this finding

**${title}** · Foundry

${replay?.filesLost ? `The replay files of this run are gone: ${replay.filesLost}.` : "This run was recorded before the workspace was snapshotted, and the workspace is deleted after record."} ${testSource ? "The proof test source is in `test/AgentPoc.t.sol`." : "The proof test source was not on the recorded proof."} The scope sources and \`foundry.toml\` were not kept, so there is no command that can rerun the proof from this folder.

\`fork.json\` records \`rpc\` as ${rpcShown} and \`block\` as null. No provider key is included.
${omittedList(omitted)}`;
  const entries = [];
  pushFile(entries, "proof.json", proofJson(proof, replay && { ...replay, command: command && replaySteps(command), prepare }));
  pushFile(entries, "fork.json", JSON.stringify({ rpc: RPC_PLACEHOLDER, block: Number.isFinite(fork.block) ? fork.block : null, forked: Boolean(fork.forked) }, null, 2) + "\n");
  // A vendored file is the public library as the engine ships it: not
  // checked for leaks and not counted, like the engine's own files.
  for (const f of files) pushFile(entries, f.path, f.text, { own: f.vendored === true });
  if (!files.some((f) => f.path.startsWith("test/")) && testSource) pushFile(entries, "test/AgentPoc.t.sol", testSource);
  if (command) {
    const harm = { contract: replay?.contract || null, test: replay?.test || null, harm: bundleValue(proof?.harm ?? null), transfers: bundleValue(proof?.transfers ?? []) };
    pushFile(entries, "harm.json", JSON.stringify(harm, null, 2) + "\n");
    pushFile(entries, "check-harm.mjs", readFileSync(CHECK_HARM, "utf8"), { own: true });
    pushFile(entries, "SHA256SUMS", sha256Sums(entries), { own: true });
  }
  // Line 1 also says what the folder re-checks, or that it cannot rerun the
  // proof at all, so a reader of one line is not misled.
  const line1 = verdictLine(command ? harmCheck(harm).short : `This bundle cannot be re-run from this folder: ${noRerun}.`);
  return finish(entries, line1 + readme);
}

function httpBundle({ finding, recorded, proof }) {
  const raw = recorded?.script ?? finding?.script ?? null;
  let text = raw ? bundleText(raw) : null;
  // A script over the redactor's cap comes back as the mark: it is not shipped.
  const scriptOverCap = Boolean(text && CAP_MARK.test(text));
  if (scriptOverCap) text = null;
  const transcript = bundleValue(Array.isArray(proof?.log) ? proof.log : Array.isArray(proof?.exchanges) ? proof.exchanges : []);
  const rerun = scriptOverCap
    ? { why: `the request script is ${OVER_CAP}, so it is left out` }
    : labRerun({ pack: recorded?.pack ?? finding?.pack ?? null, proof, script: text });
  const entries = [];
  pushFile(entries, "proof.json", proofJson(proof, null));
  pushFile(entries, "transcript.json", JSON.stringify(transcript, null, 2) + "\n");
  if (text) pushFile(entries, "script.mjs", text.endsWith("\n") ? text : text + "\n");
  if (rerun.pack) {
    pushFile(entries, "rerun.json", JSON.stringify({ pack: rerun.pack, image: rerun.image, oracle: rerun.oracle, engine: engineHashes(rerun.pack) }, null, 2) + "\n", { own: true });
    pushFile(entries, "rerun.mjs", readFileSync(RERUN, "utf8"), { own: true });
    pushFile(entries, "SHA256SUMS", sha256Sums(entries), { own: true });
  }
  const line1 = verdictLine(rerun.pack ? "The oracle is re-checked by `rerun.mjs` against the pack's lab." : `This bundle cannot be re-run from this folder: ${rerun.why}.`);
  return finish(entries, line1 + httpReadme({ title: bundleText(finding?.title || "Finding"), hasScript: Boolean(text), scriptOverCap, rerun }));
}

// Zip bytes for one finding. `recorded` is the raw run row (replay snapshot,
// request script, proof). `finding` is the normalized finding the report uses.
// Either may be missing fields; the zip says what it could not include.
export function buildReplayBundle({ finding, recorded } = {}) {
  return planReplayBundle({ finding, recorded }).zip;
}

// The zip and the list of values it could not judge ({ shape, count, text },
// counts only). The report route sends the list with the zip.
export function planReplayBundle({ finding, recorded } = {}) {
  const refused = bundleRefusal({ finding, recorded });
  if (refused) throw new BundleRefused(refused);
  const proof = recorded?.proof || finding?.proof || null;
  const replay = recorded?.replay || proof?.replay || null;
  const kind = replay?.kind || proof?.kind || finding?.proofKind || "forge";
  if (kind === "http") return httpBundle({ finding, recorded, proof });
  return forgeBundle({ finding, recorded, replay, proof });
}
