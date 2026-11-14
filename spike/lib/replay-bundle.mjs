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
import { createHash, randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../../app/server/redact.mjs";
import { Mnemonic, wordlists } from "ethers";
import { pinnedSolc, forgeTest, forgeReplayCommand, forgePrepareCommand, FOUNDRY_IMAGE } from "./sandbox.mjs";
import { currentDemoResources, registerDemoDirectory, removeDemoDirectory } from "./demo-resources.mjs";

const MAX_FILE = 1_500_000;   // per file, checked by stat before any read
const MAX_TOTAL = 8_000_000;  // bytes across the bundle
const MAX_FILES = 5_000;      // file-count cap; past it the bundle makes no re-run claim
const MAX_BUILDINFO = 64 * 1024 * 1024; // the build-info is agent-written; stat before reading
const SKIP_DIRS = new Set(["node_modules", "out", "cache", "broadcast", "artifacts", "oracle", "coverage", "dist", "target"]);
// A file that is a key, not a source file that mentions one. Dropped whole.
const SECRET_CONTENT = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
];
// A file whose name says it is a secret, re-added after PR 6 removed it as dead
// code: now that an allow-list of sources ships, a `.key`/keystore/`.env` that
// sneaks in by name is left out. (Hidden names are already dropped.)
const SECRET_NAME = /(?:\.(?:key|pem|p12|pfx|keystore|jks|asc|gpg|ovpn|env)$|^UTC--|wallet|password|passwd|secret|credential|mnemonic|\bid_(?:rsa|dsa|ecdsa|ed25519)\b)/i;
// A JSON web3 keystore (an encrypted key that can be cracked offline).
const KEYSTORE = /"crypto"\s*:\s*\{[\s\S]*?"ciphertext"/;
// A file whose whole body is one bare 64-hex value (a raw private key).
const BARE_HEX = /^\s*(?:0x)?[0-9a-fA-F]{64}\s*$/;
// The reason a file is left out by name or body, or null.
function secretFile(rel, raw) {
  const base = rel.split("/").pop() || "";
  if (SECRET_NAME.test(base)) return "a secret-shaped name";
  if (typeof raw === "string") {
    if (BARE_HEX.test(raw)) return "a bare 64-hex value";
    if (KEYSTORE.test(raw)) return "a keystore";
    if (SECRET_CONTENT.some((re) => re.test(raw))) return "a secret body";
  }
  return null;
}
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
// A real home path is masked to ~, but /home/foundry is the Foundry image's
// own home, not an operator path, so it is left alone.
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

// A JSON value for the zip: no controlTrace, no stored replay snapshot, no
// normalized rerunCommand (the forge bundle has no re-run command), every
// string through bundleText. A two-string array (a header list as
// [name, value] pairs) is shown to the module as a {name, value} cell.
const PAIR = "__touchstonePair";
function dropKeys(v) {
  if (Array.isArray(v)) return v.map(dropKeys);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (k !== "controlTrace" && k !== "replay" && k !== "rerunCommand") out[k] = dropKeys(x);
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
// A shipped file is a source or config text: redact it, and leave it out on a
// secret name/body or when it is over the redactor's 64 KB single-pass cap (it
// cannot be masked in one pass). This runs at snapshot time on the allow-list
// and again at bundle time on an old record's inline files, so both are filtered.
function forgeFileText(path, raw) {
  const secret = secretFile(path, raw);
  if (secret) return { reason: secret };
  const text = path === "foundry.toml" ? scrubFoundryToml(raw) : bundleText(raw, { forge: true });
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

// The files a Foundry bundle ships are an ALLOW-list, not a walk of the
// agent-writable folder: the sources the compiler actually read for this proof
// (forge writes them to out/build-info/<hash>.json as source_id_to_path), plus
// foundry.toml and remappings.txt. Data files a test reads through cheatcodes
// (a .hex, a Safe artifact JSON) are NOT shipped: that would be a deny-list over
// untrusted content, and a proof that needs one makes no re-run claim instead.
// If build-info is missing, fall back to every .sol under the workspace (still
// sources only). Each candidate then passes fileGuard and the redactor.
function compiledSources(ws) {
  const dir = join(ws, "out", "build-info");
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return null; }
  if (!files.length) return null;
  // The newest build-info is this proof's compile.
  const newest = files
    .map((f) => { try { const st = statSync(join(dir, f)); return { f, at: st.mtimeMs, size: st.size }; } catch { return null; } })
    .filter(Boolean)
    .sort((x, y) => y.at - x.at)[0];
  if (!newest) return null;
  // The build-info is agent-written: stat its size before any read (M3).
  if (newest.size > MAX_BUILDINFO) return "too-large";
  try {
    const j = JSON.parse(readFileSync(join(dir, newest.f), "utf8"));
    // Only .sol paths: a forged build-info cannot name a .json to ship (Minor 3).
    const paths = Object.values(j.source_id_to_path || {}).filter((p) => typeof p === "string" && p.endsWith(".sol"));
    return paths.length ? [...new Set(paths)] : null;
  } catch {
    return null;
  }
}
function allSol(root) {
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
      if (e.isFile() && e.name.endsWith(".sol")) found.push([...parts, e.name].join("/"));
    }
  };
  walk(root, []);
  return found;
}
function collectForgeFiles(ws) {
  const config = ["foundry.toml", "remappings.txt"].filter((f) => existsSync(join(ws, f)));
  const compiled = compiledSources(ws);
  if (compiled === "too-large") {
    // The compiled-source list cannot be read safely: ship no sources, say why.
    return { paths: [...config], note: `the build-info is larger than ${Math.round(MAX_BUILDINFO / (1024 * 1024))} MB, so the compiled-source list was not read and the sources are not in this bundle`, fromBuildInfo: false };
  }
  const sources = compiled ?? allSol(ws);
  const all = [...new Set([...config, ...sources])];
  all.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  return { paths: all, note: null, fromBuildInfo: Array.isArray(compiled) };
}

// The filesystem checks a candidate must pass before it is read, so an
// untrusted workspace cannot leak a file the allow-list named by mistake:
// a regular file, not a hard link (nlink 1), inside the workspace after
// realpath, not hidden, under the per-file size cap. Returns { size } or
// { reason }. The read never happens for a file that fails.
function fileGuard(ws, rel) {
  const base = rel.split("/").pop() || "";
  if (!base || base.startsWith(".")) return { reason: "a hidden file" };
  const abs = join(ws, rel);
  let st;
  try { st = lstatSync(abs); } catch { return { reason: "a file that could not be read" }; }
  if (st.isSymbolicLink() || !st.isFile()) return { reason: "not a regular file" };
  if (st.nlink > 1) return { reason: "a hard link" };
  let real;
  try { real = realpathSync(abs); } catch { return { reason: "a file that could not be read" }; }
  let wsReal;
  try { wsReal = realpathSync(ws); } catch { wsReal = ws; }
  if (real !== wsReal && !real.startsWith(wsReal + sep)) return { reason: "outside the workspace" };
  if (st.size > MAX_FILE) return { reason: "larger than 1.5 MB" };
  return { size: st.size };
}

// Snapshot the workspace that just proved a forge finding. Call this before
// the workspace is deleted. The result is JSON-safe and is stored on the proof.
export function snapshotForgeReplay(ws, { contract, test } = {}) {
  const { paths, note: collectNote, fromBuildInfo } = collectForgeFiles(ws);
  const files = [];
  const omitted = [];
  let total = 0;
  let capped = 0;
  // Past the file-count cap the bundle cannot be complete, so it makes no claim.
  const tooMany = paths.length > MAX_FILES;
  for (const rel of (tooMany ? [] : paths)) {
    if (pathMasked(rel)) {
      omitted.push({ path: MASKED_PATH, reason: "its path holds a value the redactor masks" });
      continue;
    }
    const g = fileGuard(ws, rel);
    if (g.reason) {
      omitted.push({ path: rel, reason: g.reason });
      continue;
    }
    let buf;
    try { buf = readFileSync(join(ws, rel)); } catch { omitted.push({ path: rel, reason: "a file that could not be read" }); continue; }
    const lib = vendoredFile(rel, buf);
    if (lib) {
      total += buf.length;
      files.push({ path: rel, vendored: lib });
      continue;
    }
    if (buf.includes(0)) {
      omitted.push({ path: rel, reason: "binary" });
      continue;
    }
    const raw = buf.toString("utf8");
    if (total + raw.length > MAX_TOTAL) {
      capped++;
      continue;
    }
    total += raw.length;
    const out = forgeFileText(rel, raw);
    if (out.reason) omitted.push({ path: rel, reason: out.reason });
    else files.push({ path: rel, text: out.text });
  }
  if (collectNote) omitted.push({ path: "", reason: collectNote });
  if (tooMany) omitted.push({ path: "", reason: `the workspace has ${paths.length} files, over the ${MAX_FILES} cap, so the bundle is not complete` });
  if (capped) omitted.push({ path: "", reason: `bundle size cap; ${capped} file${capped === 1 ? "" : "s"} left out` });
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
  // No re-run command is stored: a Foundry bundle ships files, hashes and the
  // README, not a command (see forgeReadme).
  return {
    version: 1,
    kind: "forge",
    contract: testIdent(contract),
    test: testIdent(test),
    solc: pinnedSolc(ws),
    fromBuildInfo,
    fork,
    files,
    omitted,
  };
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
  const kept = new Set();
  for (const f of readdirSync(dir)) {
    const m = /^([a-f0-9]{64})\.json$/.exec(f);
    if (!m) continue;
    if (!named.has(m[1])) {
      rmSync(join(dir, f), { force: true });
      removed++;
      continue;
    }
    kept.add(m[1]);
    try {
      for (const v of readFileSync(join(dir, f), "utf8").matchAll(HASH_FIELD)) libs.add(v[1]);
    } catch {
      return { removed, blobs: 0, stopped: "a replay file could not be read" };
    }
  }
  // A re-run verdict goes with its store file: one whose store file is gone,
  // or that cannot be read, and a temp file left by a stopped write, go too.
  let verdicts = 0;
  const rerun = join(dir, RERUN_DIR);
  if (existsSync(rerun)) {
    for (const f of readdirSync(rerun)) {
      if (f === RERUN_WORK) {
        verdicts += sweepWork(dir);
        continue;
      }
      const at = join(rerun, f);
      let keep = false;
      if (/^[a-f0-9]{64}\.json$/.test(f)) {
        try { keep = kept.has(JSON.parse(readFileSync(at, "utf8"))?.store); } catch { keep = false; }
      }
      if (!keep) {
        rmSync(at, { recursive: true, force: true });
        verdicts++;
      }
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
  return { removed, blobs, verdicts };
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

// A Foundry bundle ships files, hashes and this README. It makes no re-run
// claim: closing the "claims a re-run it cannot do" class needs every
// workspace file, which is a later task. The README says what the folder is
// and what it is not.
function forgeReadme({ title, replay, fork, libs = [], haveCommand, cheat, checked = null }) {
  const block = Number.isFinite(fork?.block) ? String(fork.block) : "null";
  const forkNote = fork?.forked
    ? `The proof forked a chain; \`fork.json\` records the block as ${block}. The RPC endpoint is not in this folder, and the offline re-run cannot fork, so it is not re-run-checked.`
    : `The proof did not fork a chain; \`fork.json\` records \`rpc\` as ${rpcShown} and \`block\` as ${block}.`;
  // Minor 3: say "the compiled sources" only when they came from the build-info;
  // the fallback ships every .sol in the workspace.
  const sourceLine = replay?.fromBuildInfo
    ? "the compiled sources the proof read, the proof test, and the Foundry config"
    : "every .sol source in the workspace, the proof test, and the Foundry config";
  // Minor 2: name the cheatcode that reads a file the bundle does not ship.
  const dataLine = cheat
    ? `This proof reads a file that is not in the bundle (${cheat}), so it has no re-run command.`
    : "A data file the proof reads through a cheatcode is not shipped, so a proof that needs one is not re-run-checked.";
  const section = haveCommand ? forgeReplaySection({ solc: replay?.solc, matchContract: replay?.contract, checked }) : "";
  return `# Proof source for this finding

**${title || "Finding"}** · Foundry

This folder holds the proof's source files: ${sourceLine}. ${dataLine} \`proof.json\` is the recorded verdict, and \`SHA256SUMS\` is the hash of every file here. ${forkNote}

A library's own test suite under \`lib/\` is not included: the proof does not import it, and some ship sample provider keys.${vendoredNote(libs)} No provider key and no bearer token from the run is in this folder.
${section}${omittedList(replay?.omitted)}`;
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

function pushFile(entries, name, text, { own = false, data = false } = {}) {
  const path = zipPath(name);
  if (!path || entries.some((e) => e.name === path)) return;
  if (!own) {
    const shapes = leakShapes(text);
    if (shapes.length) throw new BundleRefused(`No replay bundle: ${path} holds ${shapes.join(" and ")} that the redactor cannot mask, so the zip would leak it.`);
  }
  // `dataFile` marks a shipped artifact (bytecode/ABI): leak-checked, but not
  // window-counted for unjudged values, so its hex does not flood the list.
  entries.push({ name: path, data: Buffer.from(String(text), "utf8"), own, dataFile: data });
}

// The README goes first, with the list of values the bundle could not judge.
// The count runs over every file the zip takes from the record, the README
// head included; the engine's own files are not counted.
function finish(entries, head) {
  const counts = {};
  unjudgedCounts(head, counts);
  for (const e of entries) if (!e.own && !e.dataFile) unjudgedCounts(e.data.toString("utf8"), counts);
  const unjudged = unjudgedList(counts);
  const section = unjudged.length
    ? `\n## ${UNJUDGED_NOTE}\n\nThe redactor could not judge these values. Each one may be a secret, or it may be evidence (a transaction hash, a storage slot, an id). They are counted here, not shown:\n\n${unjudged.map((u) => `- ${u.text}`).join("\n")}\n`
    : `\n## ${UNJUDGED_NOTE}\n\nThe bundle found no value it could not judge: no 64-hex value, no 40-character token, and no long URL part outside a known provider.\n`;
  const readme = [];
  pushFile(readme, "README.md", head.endsWith("\n") ? head + section : `${head}\n${section}`);
  return { zip: zipStore([...readme, ...entries]), unjudged };
}

// Line 1 of every README. The normalized finding's stages.proven is the app's
// verdict; a raw record falls back to pocProved. Anything else is not proven.
// bundleRefusal lets only a proven finding through, so line 1 starts PROVEN.
// It goes on to say whether this folder can rerun the proof.
function verdictLine(rest = "") {
  return `PROVEN: the engine's proof gate passed this finding when it was recorded.${rest ? ` ${rest}` : ""}\n\n`;
}

// The harm kind as a short noun, from the recorded harm, for line 1.
function harmNoun(harm) {
  if (!harm || harm.ok !== true) return null;
  if (harm.kind === "funds" && !harm.asset) return "an ETH drain";
  if (harm.kind === "funds" && harm.asset === "token") return "a token drain";
  if (harm.kind === "control") return "a control takeover";
  return `the recorded harm`;
}
// A real wall-clock date for the proof (UTC YYYY-MM-DD), or null. Only a true
// time counts: the proof's own time if a record ever holds one, else the run's
// start time (findings.mjs getFinding sends it as `at`). The run's `ms` is a
// DURATION in milliseconds, never a date, so it is never read here. A time
// before 2020 or in the future is not a believable record date and is dropped.
const MIN_PROVEN_MS = Date.UTC(2020, 0, 1);
export function provenDate({ finding, recorded } = {}) {
  const proof = recorded?.proof || finding?.proof || null;
  const at = [proof?.at, recorded?.at, finding?.at].find((v) => Number.isFinite(v) && v >= MIN_PROVEN_MS && v <= Date.now());
  if (!at) return null;
  try { return new Date(at).toISOString().slice(0, 10); } catch { return null; }
}
// Line 1 of a Foundry bundle README. bundleRefusal lets only a proven finding
// reach here, so it states the proof plainly, with the date and harm kind from
// the record, and says the folder is source to read, not a folder to re-run.
function forgeLine1({ finding, recorded, harm, haveCommand, cheat, forked, checked }) {
  const date = provenDate({ finding, recorded });
  const noun = harmNoun(harm);
  const head = `Touchstone proved this finding by its own replay${date ? ` on ${date}` : ""}${noun ? ` (harm: ${noun})` : ""}`;
  // An automatic re-run check does not ship yet, so the bundle makes no re-run
  // claim: it carries the exact command for you to run by hand.
  if (haveCommand && checked) return `PROVEN: ${head}. These files were re-run-checked: Touchstone re-ran them offline${verdictDay(checked) ? ` on ${verdictDay(checked)}` : ""} and the proof test passed; the re-run command is in this README.\n\n`;
  if (haveCommand) return `PROVEN: ${head}. These files are not re-run-checked (no passing offline check of these exact files); the re-run command is in this README for you to run.\n\n`;
  if (cheat) return `PROVEN: ${head}. This proof reads a file that is not in the bundle (${cheat}), so it has no re-run command.\n\n`;
  if (forked) return `PROVEN: ${head}. This proof forked a chain, which an offline re-run cannot, so it has no re-run command.\n\n`;
  return `PROVEN: ${head}. This folder holds the proof's source files for reading; it has no re-run command.\n\n`;
}

// The README's re-run section: the exact offline command, a prepare step for a
// fresh machine, and whether Touchstone's own re-run of these files passed.
// The UTC day of a verdict's check, or null (the same believable-date rule
// as provenDate: from 2020 to now).
function verdictDay(v) {
  const at = v?.at;
  if (!Number.isFinite(at) || at < MIN_PROVEN_MS || at > Date.now()) return null;
  try { return new Date(at).toISOString().slice(0, 10); } catch { return null; }
}
function forgeReplaySection({ solc, matchContract, checked = null }) {
  const command = forgeReplayCommand({ matchContract, solc });
  const prepare = forgePrepareCommand({ solc });
  const prep = prepare ? `\n## Prepare (once, online)\n\nOn a fresh machine, create and warm the pinned image's solc cache:\n\n\`\`\`sh\n${prepare}\n\`\`\`\n` : "";
  const passLine = matchContract
    ? "A pass means the named test compiled and passed from these files alone."
    : "A pass means the bundle compiled and its tests passed from these files alone.";
  const lead = checked
    ? `Touchstone re-ran these exact files offline${verdictDay(checked) ? ` on ${verdictDay(checked)}` : ""} (the pinned image, no network), and the proof test passed. Run it yourself from this folder:`
    : "These files are not re-run-checked (no passing offline check of these exact files). Run the proof yourself from this folder:";
  return `\n## Re-run (offline)\n\n${lead}\n\n\`\`\`sh\nsha256sum -c SHA256SUMS && \\\n  ${command}\n\`\`\`\n\nThe image is pinned by digest and the container has no network (\`--network none\`). ${passLine}\n${prep}`;
}

// The cheatcodes that make a proof read a file from the workspace a bundle does
// not ship. The `fs` class from the pinned forge table covers ffi and the
// writers; the file-content reads are classed `read` there (mixed with
// non-file ops), so they are listed by name. getCode/getDeployedCode are read
// cheatcodes too, but only when their argument is a path, not an `X.sol[:Name]`
// artifact that forge resolves from out/. A hit drops the re-run command and
// the README names the cheatcode (never a path of this host).
const FS_CLASS = (() => {
  try {
    const list = JSON.parse(readFileSync(new URL("./vm-cheatcodes.json", import.meta.url), "utf8"));
    return new Set(list.filter((c) => c && c.class === "fs").map((c) => c.name));
  } catch {
    return new Set(["ffi", "tryFfi", "writeFile", "writeFileBinary", "writeLine", "writeJson", "writeToml", "copyFile", "createDir", "removeDir", "removeFile", "dumpState"]);
  }
})();
const FILE_READS = ["readFile", "readFileBinary", "readLine", "readDir",
  // File probes and path helpers (read class in the pinned forge table): a proof
  // that asks the file system decides on files the bundle may not hold.
  "exists", "isFile", "isDir", "readLink", "fsMetadata", "projectRoot", "closeFile", "currentFilePath",
  "getArtifactPathByCode", "getArtifactPathByDeployedCode"];
// forge-std helpers whose body reads a file (StdCheats: vm.readFile). They are
// called bare or on any receiver, so any call of one is a hit.
const FORGE_STD_FILE_HELPERS = new Set(["readEIP1559ScriptArtifact", "readTx1559s", "readTx1559", "readReceipts", "readReceipt"]);
const FILE_CHEATS = new Set([...FS_CLASS, ...FILE_READS]);
// The artifact family loads code by name. A use counts as safe only when its
// first argument is a string literal that names a contract the bundle ships:
// "File.sol", "path/File.sol", "File.sol:Name", or a bare "Name". Any other
// argument (a variable, a constant, a concatenation, a .json or other path)
// may read a file the bundle does not hold, so it is a hit: unknown means no
// command. The family is matched on any receiver and bare (forge-std's
// StdCheats calls deployCode with no receiver).
const ARTIFACT_FAMILY = ["getCode", "getDeployedCode", "deployCode", "deployCodeTo"];
// loadAllocs always reads a JSON file: every use is a hit.
const ALWAYS_FILE = new Set(["loadAllocs"]);
const SOL_REF = /^(?:[\w$.\/-]*\/)?([\w$-]+\.sol)(?::([A-Za-z_$][\w$]*))?$/;
const BARE_NAME = /^[A-Za-z_$][\w$]*$/;
function firstStringArg(afterParen) {
  const m = /^\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*[,)]/.exec(afterParen);
  return m ? m[2] : null;
}
function stripComments(text) {
  return String(text ?? "").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
}
// The contracts the shipped sources declare, and their file names.
function shippedNames(sources) {
  const files = new Set();
  const contracts = new Set();
  for (const { path, text } of sources) {
    files.add(path.split("/").pop());
    files.add(path);
    for (const m of stripComments(text).matchAll(/\b(?:abstract\s+)?(?:contract|library)\s+([A-Za-z_$][\w$]*)/g)) contracts.add(m[1]);
  }
  return { files, contracts };
}
function artifactShipped(arg, names) {
  const ref = SOL_REF.exec(arg);
  if (ref) {
    const fileOk = names.files.has(ref[1]) || names.files.has(arg.split(":")[0]);
    return fileOk && (!ref[2] || names.contracts.has(ref[2]));
  }
  return BARE_NAME.test(arg) && names.contracts.has(arg);
}
// The argument text is a lookahead, so a match never consumes the calls after it.
const CALL = new RegExp("(?<![\\w$])(?:([A-Za-z_$][\\w$]*)\\s*\\.\\s*)?([A-Za-z_$][\\w$]*)\\s*\\((?=([\\s\\S]{0,160}))", "g");
// The first file read a shipped source makes, as a label ("vm.getCode",
// "deployCode"), or null. `sources` is [{ path, text }]. Both the raw and the
// comment-stripped text are scanned, so a "//" inside a string cannot hide a
// call; a call inside a comment then also counts, which fails closed.
function fileCheatUsed(sources) {
  const names = shippedNames(sources);
  for (const { text } of sources) {
    for (const code of [String(text ?? ""), stripComments(text)]) {
      CALL.lastIndex = 0;
      let m;
      while ((m = CALL.exec(code))) {
        const [, receiver, name, rest] = m;
        if (/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue; // a definition
        const label = receiver ? `vm.${name}` : name;
        if (receiver && FILE_CHEATS.has(name)) return label;
        if (FORGE_STD_FILE_HELPERS.has(name)) return label;
        if (ALWAYS_FILE.has(name)) return label;
        if (ARTIFACT_FAMILY.includes(name)) {
          const arg = firstStringArg(rest);
          if (arg === null || !artifactShipped(arg, names)) return label;
        }
      }
    }
  }
  return null;
}

// The final text files a bundle ships (vendored resolved, redacted), including
// the proof test source written as test/AgentPoc.t.sol. Both the verifier and
// the zip compute the claim hash over exactly this set.
function shippedFiles(tree) {
  const out = tree.files.filter((f) => typeof f.text === "string").map((f) => ({ path: f.path, text: f.text }));
  if (tree.testSource && !tree.files.some((f) => f.path.startsWith("test/"))) out.push({ path: "test/AgentPoc.t.sol", text: tree.testSource });
  return out;
}
// A hash over the checked file set: each path and the hash of its bytes, sorted
// by path. The re-run claim is bound to this, so a pass stored for one set of
// files is not shown for a different set (a lost store file, a changed file).
function treeHash(files) {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(f.path).update("\0").update(createHash("sha256").update(String(f.text)).digest("hex")).update("\n");
  }
  return h.digest("hex");
}

// The redacted file tree a Foundry bundle ships: the shipped files (vendored
// resolved to the engine's bytes, every other text re-redacted), the libraries
// used, what was left out, the proof test source, and the fork. Both the zip
// and the re-run verifier build from this, so they ship the same bytes.
function forgeFileTree({ finding, recorded, replay, proof }) {
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
    else files.push({ path: f.path, text: out.text, ...(out.data || f.data ? { data: true } : {}) });
  }
  let testSource = proof?.testSource || finding?.proof?.testSource || null;
  if (testSource && !files.some((f) => f.path.startsWith("test/"))) {
    const out = forgeFileText("test/AgentPoc.t.sol", testSource);
    if (out.reason) omitted.push({ path: "test/AgentPoc.t.sol", reason: out.reason });
    testSource = out.text ?? null;
  }
  const fork = replay?.fork || { rpc: RPC_PLACEHOLDER, block: null, forked: false };
  const haveProject = files.some((f) => f.path === "foundry.toml") && (files.some((f) => f.path.startsWith("test/")) || Boolean(testSource));
  return { files, libs, omitted, testSource, fork, haveProject };
}

function forgeBundle({ finding, recorded, replay, proof }) {
  const title = bundleText(finding?.title || "Finding");
  const tree = forgeFileTree({ finding, recorded, replay, proof });
  const { files, libs, testSource, fork, haveProject } = tree;
  const omitted = tree.omitted;
  replay = replay && { ...replay, omitted };
  const harm = proof?.harm ?? null;
  const { haveCommand, cheat } = commandPlan(tree);
  // The re-run claim: the verdict side file keyed by the hash of the files
  // this bundle ships NOW. Only an exact hit with a pass claims; every other
  // case keeps the "not re-run-checked" wording.
  // The command the README prints now: the verdict must be for exactly this.
  const printed = forgeReplayCommand({ matchContract: replay?.contract, solc: replay?.solc });
  const verdict = haveCommand ? readRerunVerdict(recorded?.rerunDir, { tree: treeHash(shippedFiles(tree)), command: printed }) : null;
  const checked = verdict?.pass === true ? verdict : null;
  const readme = files.length
    ? forgeReadme({ title, replay, fork, libs, haveCommand, cheat, checked })
    : `# Proof source for this finding

**${title}** · Foundry

${replay?.filesLost ? `The proof's source files of this run are gone: ${replay.filesLost}.` : "This run was recorded before the workspace was snapshotted, and the workspace is deleted after record."} ${testSource ? "The proof test source is in `test/AgentPoc.t.sol`." : "The proof test source was not on the recorded proof."} The scope sources and \`foundry.toml\` were not kept.

\`fork.json\` records \`rpc\` as ${rpcShown} and \`block\` as null. No provider key is included.
${omittedList(omitted)}`;
  const entries = [];
  pushFile(entries, "proof.json", proofJson(proof, replay));
  pushFile(entries, "fork.json", JSON.stringify({ rpc: RPC_PLACEHOLDER, block: Number.isFinite(fork.block) ? fork.block : null, forked: Boolean(fork.forked) }, null, 2) + "\n");
  // A vendored file is the public library as the engine ships it: not
  // checked for leaks and not counted, like the engine's own files.
  for (const f of files) pushFile(entries, f.path, f.text, { own: f.vendored === true, data: f.data === true });
  if (!files.some((f) => f.path.startsWith("test/")) && testSource) pushFile(entries, "test/AgentPoc.t.sol", testSource);
  // The hashes of every file the bundle ships, so a reader can check the folder.
  if (files.length || testSource) pushFile(entries, "SHA256SUMS", sha256Sums(entries), { own: true });
  return finish(entries, forgeLine1({ finding, recorded, harm, haveCommand, cheat, forked: fork.forked, checked }) + readme);
}

// Whether a bundle of this tree offers the re-run command, and the file
// cheatcode that stops it. The command needs foundry.toml and a test, no
// forked chain (an offline re-run cannot fork), and no file the bundle does
// not ship (a file cheatcode). Only the proof's own sources are scanned, not
// vendored libraries: forge-std calls ffi/getCode itself.
function commandPlan(tree) {
  const { files, testSource, fork, haveProject } = tree;
  const scanned = files.filter((f) => f.path.endsWith(".sol") && typeof f.text === "string" && f.vendored !== true).map((f) => ({ path: f.path, text: f.text }));
  // The PoC can come from proof.testSource instead of a shipped test/ file.
  if (testSource && !files.some((f) => f.path.startsWith("test/"))) scanned.push({ path: "test/AgentPoc.t.sol", text: testSource });
  const cheat = fileCheatUsed(scanned);
  return { haveCommand: Boolean(haveProject && !fork.forked && !cheat), cheat };
}

// ---- The re-run verdict side store (H3c). --------------------------------
// A verdict lives in <replay store>/rerun/<key>.json, never in a run record.
// The key binds the verdict to WHAT was checked: the hash of the files AND the
// exact forge command the README prints (it names the test contract with
// --match-contract and the pinned image digest). Two findings of one run ship
// the same files but run different test contracts: each gets its own file.
// The file holds no source text and no secret: the key, the tree hash, the
// store file it came from, pass/fail, the image digest, the command, the time.
// The bundle builder computes the key from the files it ships now and the
// command it prints now, and reads that one path.
const RERUN_DIR = "rerun";
const RERUN_MAX = 4096;
// The check's private work folders, under this store only: a check killed
// half way leaves its folder here, and the next check or prune removes it.
const RERUN_WORK = ".work";
const WORK_STALE_MS = 15 * 60 * 1000; // past forgeTest's 180 s bound with room
export function rerunKey(tree, command) {
  return createHash("sha256").update(`${tree}\n${command}`).digest("hex");
}
function rerunPath(storeDir, key) {
  return join(storeDir, RERUN_DIR, `${key}.json`);
}
// The verdict for these files and this command, or null. A missing, damaged or
// foreign file (other version, other key, other tree, other command, other
// image) reads as no verdict.
export function readRerunVerdict(storeDir, { tree, command } = {}) {
  if (typeof storeDir !== "string" || !storeDir || !STORE_HASH.test(String(tree)) || typeof command !== "string" || !command) return null;
  const key = rerunKey(tree, command);
  const file = rerunPath(storeDir, key);
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > RERUN_MAX) return null;
    const v = JSON.parse(readFileSync(file, "utf8"));
    if (v?.version !== 2 || v.key !== key || v.tree !== tree || v.command !== command) return null;
    if (typeof v.pass !== "boolean" || v.image !== FOUNDRY_IMAGE || !Number.isFinite(v.at)) return null;
    return v;
  } catch {
    return null;
  }
}
// Write a verdict with a temp file of its own and a rename, so two checks of
// one key at once leave one whole file and a stop mid-write leaves none.
export function writeRerunVerdict(storeDir, v) {
  const file = rerunPath(storeDir, v.key);
  mkdirSync(join(storeDir, RERUN_DIR), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(v) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}
// Remove this store's own check folders that are older than WORK_STALE_MS (a
// check killed half way). Only folders inside <store>/rerun/.work are touched,
// each by its exact path; a live check's folder is younger and stays.
function sweepWork(storeDir) {
  const work = join(storeDir, RERUN_DIR, RERUN_WORK);
  let removed = 0;
  let names = [];
  try { names = readdirSync(work); } catch { return 0; }
  for (const name of names) {
    if (!/^check-[a-f0-9]{12}$/.test(name)) continue;
    const at = join(work, name);
    try {
      const st = lstatSync(at);
      if (st.isDirectory() && Date.now() - st.mtimeMs > WORK_STALE_MS) {
        rmSync(at, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // gone already
    }
  }
  return removed;
}
// Check one recorded Foundry replay (the record's pointer) and write its
// verdict. A proof whose bundle offers no command is not run: it can never
// claim. Returns the verdict written, or null.
export async function checkReplayRerun({ replay, proof } = {}, { storeDir = replayStoreDir(), run } = {}) {
  if (!replay?.store?.sha256) return null;
  const loaded = loadReplayFiles(replay, storeDir);
  if (!Array.isArray(loaded?.files) || !loaded.files.length) return null;
  const tree = forgeFileTree({ finding: {}, recorded: { replay: loaded, proof }, replay: loaded, proof });
  if (!commandPlan(tree).haveCommand) return null;
  sweepWork(storeDir);
  const work = join(storeDir, RERUN_DIR, RERUN_WORK);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const r = await verifyForgeReplay({ replay: loaded, proof }, { run, workDir: work });
  if (!r?.tree) return null; // the check never ran
  const key = rerunKey(r.tree, r.command);
  const v = { version: 2, key, tree: r.tree, store: replay.store.sha256, pass: r.pass === true, image: r.image, command: r.command, at: Date.now(), ...(r.reason ? { reason: r.reason } : {}) };
  writeRerunVerdict(storeDir, v);
  return v;
}
// After a run's record is written: check each proven Foundry finding, one at a
// time. It reads the in-memory findings and writes only side files; it never
// touches the run record. Errors are swallowed per finding.
export async function checkRecordedReplays(findings, { storeDir = replayStoreDir(), run } = {}) {
  let checked = 0;
  for (const f of Array.isArray(findings) ? findings : []) {
    const proof = f?.proof;
    if (f?.pocProved !== true || proof?.kind !== "forge" || !proof?.replay?.store) continue;
    try {
      if (await checkReplayRerun({ replay: proof.replay, proof }, { storeDir, run })) checked++;
    } catch {
      // best effort: no verdict means no claim
    }
  }
  return { checked };
}

// Re-run the Foundry proof from the bundle's own files, offline, and say
// whether it passed. This is the ONLY authority for the "re-run checked" claim:
// a static rule over which files a proof reads could not close the class (three
// review rounds). record.mjs calls this once when the finding is recorded, with
// Docker available and the workspace still warm, and stores the verdict on the
// replay; the download request never runs Docker. `run` is injected for tests.
// Returns { checked, pass, command, prepare, image, matchContract, solc, ms?, reason? }.
export async function verifyForgeReplay({ replay, proof, finding, recorded } = {}, { run, workDir = null } = {}) {
  const matchContract = replay?.contract || null;
  const solc = replay?.solc ?? null;
  const base = {
    checked: true,
    command: forgeReplayCommand({ matchContract, solc }),
    prepare: forgePrepareCommand({ solc }),
    image: FOUNDRY_IMAGE,
    matchContract,
    solc,
  };
  if (replay?.fork?.forked) return { ...base, pass: false, reason: "the proof forked a chain, which the offline re-run cannot" };
  let tree;
  try {
    tree = forgeFileTree({ finding: finding ?? {}, recorded: recorded ?? { replay, proof }, replay, proof });
  } catch (err) {
    return { ...base, pass: false, reason: `the bundle could not be built (${String(err?.message || err).slice(0, 80)})` };
  }
  if (!tree.haveProject) return { ...base, pass: false, reason: "the bundle has no foundry.toml and proof test" };
  const sf = shippedFiles(tree);
  const tree_ = treeHash(sf);
  // A store check uses its private work folder; a direct call uses system temp.
  // Demo keeps the directory when its registered resource cleanup is unresolved.
  const demo = currentDemoResources();
  let dir = workDir ? join(workDir, `check-${randomBytes(6).toString("hex")}`) : mkdtempSync(join(tmpdir(), "replay-verify-"));
  if (workDir) mkdirSync(dir, { mode: 0o700 });
  if (demo) dir = registerDemoDirectory(demo, dir);
  try {
    for (const f of sf) {
      const abs = join(dir, f.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.text);
    }
    const runner = run ?? forgeTest;
    const t0 = Date.now();
    const r = await runner(dir, { matchContract });
    const ms = Date.now() - t0;
    const rerunPass = r?.passed === true && r?.failed !== true;
    const recordedPass = proof?.pass !== false;
    const pass = rerunPass && recordedPass;
    // Docker (or forge) could not run at all: that is "could not check", not a
    // failing proof. The claim still needs a pass, so there is none either way.
    const couldNotRun = !r?.passed && !r?.failed && (r?.code === "ENOENT" || /docker: .*not found|Cannot connect to the Docker daemon|command not found|executable file not found/i.test(String(r?.output ?? "")));
    const reason = pass ? undefined
      : couldNotRun ? "the check could not run (Docker is not available)"
      : r?.timedOut ? "the re-run timed out"
      : rerunPass ? "the recorded proof is not a pass"
      : "the proof test did not pass from the bundle folder";
    return { ...base, pass, ms, tree: tree_, ...(reason ? { reason } : {}) };
  } finally {
    if (demo) removeDemoDirectory(demo, dir);
    else rmSync(dir, { recursive: true, force: true });
  }
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
