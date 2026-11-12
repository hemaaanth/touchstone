import { HDNodeWallet, Mnemonic, Wallet, getAddress } from "ethers";
import { posix } from "node:path";
import { redactSecret } from "../../lib/proof-evidence.mjs";

const canonical = ["ethers", "web3", "viem", "@solana/web3.js"];
function nearName(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff = [...a].map((c, i) => c === b[i] ? -1 : i).filter((i) => i >= 0);
    return diff.length === 1 || (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]);
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < long.length; i++) if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  return false;
}

const lookalike = (name) => (canonical.includes(name) ? null : canonical.find((known) => nearName(name.toLowerCase(), known)) ?? null);

// Dependency checks. A scanner that reads advisories cannot see these.
// 1. Vendored code that reads a secret or signer field and, a few lines away, sends data out.
// 2. A suspect package that a source file imports AND uses to build or call a signer.
// 3. A package.json dependency that its own lockfile does not list.
// A package the lockfile pins by integrity hash, under its own name, from the npm registry is not suspect.
// Known limits (see SKILL.md): exfil split across two files, env destructuring, minified bundles,
// and code that builds the module name at run time are not seen.
const CODE = /\.[cm]?[jt]sx?$/;
const TYPES = /\.d\.[cm]?ts$/;
const SINK = /\b(?:https?\.(?:request|get)|fetch|net\.connect|dns\.resolve\w*)\s*\(|new\s+(?:XMLHttpRequest|WebSocket)\b/;
const KEYWORD = "KEY|SECRET|TOKEN|MNEMONIC|SEED|PASS";
// A named env secret or a signer field. A bare `process.env` (copied whole) is not a secret read.
const SECRET_READ = new RegExp(`process\\.env\\s*\\.\\s*\\w*(?:${KEYWORD})\\w*|process\\.env\\s*\\[\\s*["'\`][^"'\`]*(?:${KEYWORD})[^"'\`]*["'\`]\\s*\\]|\\.(?:privateKey|mnemonic|signingKey)\\b`);
const SIGNER_MATERIAL = /PRIVATE_KEY|DEPLOYER_KEY|\bprivateKey\b|\bmnemonic\b/;
const SIGNER_NAME = /Wallet|Signer|Keypair|sign|send/i;
const WINDOW = 8;
const vendoredName = (file) => file.match(/^(?:.*\/)?node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1] ?? null;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const isManifest = (file) => posix.basename(file) === "package.json";
const lineAt = (text, index) => text.slice(0, index).split("\n").length;

// Comments are not code. Keep line numbers: block comments keep their newlines.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const minified = (src) => src.length > 2000 && src.length / (src.split("\n").length) > 300;

// True when the lockfile pins this vendored package by integrity hash, under its own name, from the registry.
function lockedWithIntegrity(file, pkg, lockOf) {
  const m = file.match(/^((?:.*?\/)?)(node_modules\/.+)$/);
  if (!m) return false;
  const lock = lockOf(`${m[1]}package-lock.json`);
  if (!lock) return false;
  const path = `${m[2].slice(0, m[2].lastIndexOf("node_modules/"))}node_modules/${pkg}`;
  const entry = lock.packages?.[path] ?? (path === `node_modules/${pkg}` ? lock.dependencies?.[pkg] : undefined);
  if (!entry?.integrity || (entry.name && entry.name !== pkg)) return false;
  return !entry.resolved || /^https:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)\//.test(entry.resolved);
}

// Local names a file binds to an import or require of pkg, with the line of the first one.
function importOf(src, pkg) {
  const q = `["'\`]${esc(pkg)}(?:/[^"'\`]*)?["'\`]`;
  const patterns = [new RegExp(`import\\s+([^;]*?)\\s+from\\s*${q}`), new RegExp(`(?:const|let|var)\\s+([^;=]*?)\\s*=\\s*(?:await\\s+)?require\\s*\\(\\s*${q}\\s*\\)`)];
  let line = 0;
  const names = [];
  for (const re of patterns) {
    const m = re.exec(src);
    if (!m) continue;
    line = line ? Math.min(line, lineAt(src, m.index)) : lineAt(src, m.index);
    names.push(...(m[1].replace(/[\w$]+\s+as\s+/g, "").match(/[A-Za-z_$][\w$]*/g) ?? []).filter((n) => !["type", "default", "as"].includes(n)));
  }
  if (!line) {
    const bare = new RegExp(`(?:require\\s*\\(|import\\s*\\(?)\\s*${q}`).exec(src);
    if (bare) line = lineAt(src, bare.index);
  }
  return { line, names };
}

// Does the file use the imported binding to build or call a signer? A keyword elsewhere in the file does not count.
function usesAsSigner(src, names) {
  for (const raw of names) {
    const b = esc(raw);
    for (const m of src.matchAll(new RegExp(`\\bnew\\s+${b}\\b(?:\\.([\\w$]+))?\\s*\\(([^;]{0,200})`, "g"))) if (SIGNER_NAME.test(m[1] ?? raw) || SIGNER_MATERIAL.test(m[2])) return true;
    for (const m of src.matchAll(new RegExp(`\\b${b}\\.([\\w$]+)`, "g"))) if (SIGNER_NAME.test(m[1])) return true;
    for (const m of src.matchAll(new RegExp(`\\b${b}\\s*\\(([^;]{0,200})`, "g"))) if (SIGNER_MATERIAL.test(m[1])) return true;
  }
  return false;
}

function dependencyLeads(snapshot, add) {
  const locks = new Map();
  const lockOf = (path) => {
    if (!locks.has(path)) { try { locks.set(path, Object.hasOwn(snapshot.files, path) ? JSON.parse(snapshot.files[path]) : null); } catch { locks.set(path, null); } }
    return locks.get(path);
  };
  // suspects: package -> { impact, why }. High needs code evidence. A lookalike name alone is never a suspect.
  const suspects = new Map();
  const suspect = (pkg, impact, why) => {
    const cur = suspects.get(pkg) ?? { impact, why: [] };
    if (impact === "High") cur.impact = "High";
    if (!cur.why.includes(why)) cur.why.push(why);
    suspects.set(pkg, cur);
  };
  const vendored = new Map();
  for (const [file, source] of Object.entries(snapshot.files)) {
    const pkg = vendoredName(file);
    if (!pkg) continue;
    if (!vendored.has(pkg)) vendored.set(pkg, lockedWithIntegrity(file, pkg, lockOf));
    if (!CODE.test(file) || TYPES.test(file) || !SECRET_READ.test(source) || !SINK.test(source) || minified(source)) continue;
    const trusted = vendored.get(pkg);
    if (trusted && canonical.includes(pkg)) continue;
    const lines = stripComments(source).split("\n");
    const reads = lines.flatMap((t, i) => (SECRET_READ.test(t) ? [i] : []));
    const at = lines.findIndex((t, i) => SINK.test(t) && reads.some((r) => Math.abs(r - i) <= WINDOW));
    if (at < 0) continue;
    const impact = trusted ? "Medium" : "High";
    add("dependency-exfil-code", file, at + 1, `Vendored package ${pkg} reads secret or signer values and sends data out within ${WINDOW} lines. Static match only. Nothing was run.`, null, { package: pkg, impact });
    if (!trusted) suspect(pkg, "High", "exfil-code");
  }
  for (const [pkg, trusted] of vendored) if (!trusted && lookalike(pkg)) suspect(pkg, "Medium", "lookalike-not-locked");
  for (const [file, source] of Object.entries(snapshot.files)) {
    if (!isManifest(file) || vendoredName(file)) continue;
    let obj;
    try { obj = JSON.parse(source); } catch { continue; }
    const names = [...new Set(Object.keys({ ...obj?.dependencies, ...obj?.devDependencies, ...obj?.optionalDependencies }))];
    const lockPath = posix.join(posix.dirname(file), "package-lock.json");
    const lock = lockOf(lockPath);
    if (!lock) continue;
    const listed = new Set([...Object.keys(lock.packages ?? {}).map((k) => k.replace(/^.*node_modules\//, "")), ...Object.keys(lock.dependencies ?? {})]);
    const lines = source.split("\n");
    for (const name of names) if (!listed.has(name)) {
      add("dependency-not-in-lockfile", file, lines.findIndex((t) => t.includes(JSON.stringify(name))) + 1, `Package ${name} is in package.json but not in ${lockPath}. A lockfile scan never sees it.`, null, { package: name });
      if (lookalike(name)) suspect(name, "Medium", "lookalike-not-locked");
    }
  }
  for (const [file, source] of Object.entries(snapshot.files)) {
    if (!CODE.test(file) || TYPES.test(file) || vendoredName(file)) continue;
    let src;
    for (const [pkg, { impact, why }] of suspects) {
      if (!source.includes(pkg)) continue;
      src ??= stripComments(source);
      const { line, names } = importOf(src, pkg);
      if (line && usesAsSigner(src, names)) add("dependency-reaches-signer", file, line, `${file} imports suspect package ${pkg} and uses it to build or call a signer (${why.join(", ")}). Static match only.`, null, { package: pkg, impact });
    }
  }
}

export function cryptoLeads(snapshot) {
  const leads = [];
  const seen = new Set();
  const add = (check, file, line, description, secret, extra = {}) => {
    const summary = secret ? redactSecret(secret) : undefined;
    // One lead per secret per file. The same key on many lines is one exposure.
    if (summary) { const key = `${check}:${file}:${summary.sha256}:${extra.provider ?? ""}`; if (seen.has(key)) return; seen.add(key); }
    leads.push({ engine: "Touchstone", check, impact: ["crypto-package-lookalike", "dependency-not-in-lockfile"].includes(check) ? "Low" : "High",
      file, lines: [line], where: { file, line, ...(summary ? { fingerprint: summary.sha256 } : {}), ...(extra.package ? { package: extra.package } : {}) }, description,
      ...(summary ? { secret: summary } : {}), ...extra });
  };
  for (const [file, source] of Object.entries(snapshot.files)) {
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      // A random bytes32 is not necessarily a key. Require key/account context.
      // A minified bundle holds long hex constants. A real committed key sits on a short line.
      if ((text.length <= 1000 || !(vendoredName(file) || /\.min\.[cm]?js$/.test(file))) && /(private[_-]?key|deployer|accounts|secret[_-]?key)/i.test(text)) {
        for (const m of text.matchAll(/(?<![a-fA-F0-9])(?:0x)?[a-fA-F0-9]{64}(?![a-fA-F0-9])/g)) {
          try {
            const address = new Wallet(m[0].startsWith("0x") ? m[0] : `0x${m[0]}`).address;
            add("evm-private-key", file, i + 1, "Exposed EVM signing key. No balance or live-use claim.", m[0], { address });
          } catch { /* Invalid secp256k1 scalars are not signing keys. */ }
        }
      }
      for (const m of text.matchAll(/(?:["']|(?:mnemonic|seed(?:_phrase)?)\s*[:=]\s*)([a-z]+(?:[ \t]+[a-z]+){11,23})(?:["']|$)/gi)) {
        const phrase = m[1].trim().replace(/\s+/g, " ");
        if (Mnemonic.isValidMnemonic(phrase)) {
          add("bip39-mnemonic", file, i + 1, "Valid BIP-39 mnemonic. Address uses m/44'/60'/0'/0/0 with an empty passphrase.", m[1], { address: HDNodeWallet.fromPhrase(phrase).address });
        }
      }
      for (const m of text.matchAll(/https?:\/\/[^\s"'`<>]+/g)) {
        let u;
        try { u = new URL(m[0]); } catch { continue; }
        let key;
        let provider;
        if (/(^|\.)g\.alchemy\.com$/.test(u.hostname)) { provider = "Alchemy"; key = u.pathname.match(/\/v2\/([^/]+)/)?.[1]; }
        else if (/(^|\.)infura\.io$/.test(u.hostname)) { provider = "Infura"; key = u.pathname.match(/\/v3\/([^/]+)/)?.[1]; }
        else if (/(^|\.)quiknode\.pro$/.test(u.hostname)) { provider = "QuickNode"; key = u.pathname.split("/").filter(Boolean)[0]; }
        if (key && /^[A-Za-z0-9_-]{16,}$/.test(key)) add("rpc-provider-key", file, i + 1, `Embedded ${provider} RPC credential. Live validity is not checked.`, key, { provider });
      }
    }
    if (file.endsWith(".json")) {
      let obj;
      try { obj = JSON.parse(source); } catch { continue; }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
      const c = obj.crypto ?? obj.Crypto;
      if (obj.version === 3 && /^[0-9a-fA-F]{40}$/.test(obj.address ?? "") && c?.cipher === "aes-128-ctr" && /^[0-9a-fA-F]{64}$/.test(c.ciphertext ?? "") && c.kdf && c.mac) {
        add("evm-keystore", file, lines.findIndex((s) => s.includes('"ciphertext"')) + 1,
          "Encrypted EVM keystore is in source. Address is declared metadata, not a decrypted or proven signing key.", c.ciphertext, { address: getAddress(`0x${obj.address.toLowerCase()}`), addressSource: "keystore-metadata" });
      }
      if (isManifest(file)) {
        for (const name of new Set(Object.keys({ ...obj.dependencies, ...obj.devDependencies, ...obj.optionalDependencies, ...obj.peerDependencies }))) {
          const target = lookalike(name);
          if (target) add("crypto-package-lookalike", file, lines.findIndex((s) => s.includes(JSON.stringify(name))) + 1,
            `Package ${name} resembles ${target}. This is a name similarity warning, not proof of malware.`, null, { package: name, resembles: target });
        }
      }
    }
  }
  dependencyLeads(snapshot, add);
  return leads;
}

export const CRYPTO_CHECKS = ["evm-private-key", "bip39-mnemonic", "rpc-provider-key", "evm-keystore", "crypto-package-lookalike", "dependency-reaches-signer", "dependency-exfil-code", "dependency-not-in-lockfile"];
export const cryptoDetectors = Object.fromEntries(CRYPTO_CHECKS.map((check) => [check, (snapshot, where) => ({
  ok: cryptoLeads(snapshot).some((lead) => lead.check === check && lead.file === where?.file && lead.lines[0] === where?.line && lead.where.fingerprint === where?.fingerprint && lead.where.package === where?.package),
})]));
