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
// 1. A vendored package that reads env secrets or signer fields and sends them out.
// 2. A suspect package that a signer-handling source file imports.
// 3. A package.json dependency that its own lockfile does not list.
const CODE = /\.[cm]?[jt]sx?$/;
const SIGNER = /\b(?:Wallet|Signer|Keypair|privateKey|mnemonic|signTransaction|signMessage|sendTransaction)\b|DEPLOYER_KEY|PRIVATE_KEY/;
const SINK = /\b(?:https?\.(?:request|get)|fetch|net\.connect|dns\.resolve\w*)\s*\(|new\s+(?:XMLHttpRequest|WebSocket)\b/;
const SECRET_READ = /process\.env\s*(?:\.\s*\w*(?:KEY|SECRET|TOKEN|MNEMONIC|SEED|PASS)\w*|\[|[,)}])|\.(?:privateKey|mnemonic|signingKey)\b/;
const vendoredName = (file) => file.match(/^(?:.*\/)?node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1] ?? null;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function dependencyLeads(snapshot, add) {
  const suspects = new Map();
  const suspect = (pkg, why) => suspects.set(pkg, [...(suspects.get(pkg) ?? []), why]);
  for (const [file, source] of Object.entries(snapshot.files)) {
    const pkg = vendoredName(file);
    if (!pkg || !CODE.test(file)) continue;
    const lines = source.split("\n");
    const read = SECRET_READ.test(source), at = lines.findIndex((t) => SINK.test(t));
    if (read && at >= 0) {
      add("dependency-exfil-code", file, at + 1, `Vendored package ${pkg} reads secret or signer values and sends data out. Static match only. Nothing was run.`, null, { package: pkg });
      suspect(pkg, "exfil-code");
    }
  }
  for (const [file, source] of Object.entries(snapshot.files)) {
    if (!file.endsWith("package.json") || vendoredName(file)) continue;
    let obj;
    try { obj = JSON.parse(source); } catch { continue; }
    const names = [...new Set(Object.keys({ ...obj?.dependencies, ...obj?.devDependencies, ...obj?.optionalDependencies }))];
    for (const name of names) if (lookalike(name)) suspect(name, "lookalike");
    const lockPath = posix.join(posix.dirname(file), "package-lock.json");
    if (!Object.hasOwn(snapshot.files, lockPath)) continue;
    let lock;
    try { lock = JSON.parse(snapshot.files[lockPath]); } catch { continue; }
    const listed = new Set([...Object.keys(lock?.packages ?? {}).map((k) => k.replace(/^.*node_modules\//, "")), ...Object.keys(lock?.dependencies ?? {})]);
    const lines = source.split("\n");
    for (const name of names) if (!listed.has(name)) {
      add("dependency-not-in-lockfile", file, lines.findIndex((t) => t.includes(JSON.stringify(name))) + 1, `Package ${name} is in package.json but not in ${lockPath}. A lockfile scan never sees it.`, null, { package: name });
    }
  }
  for (const [file, source] of Object.entries(snapshot.files)) {
    if (!CODE.test(file) || vendoredName(file) || !SIGNER.test(source)) continue;
    const lines = source.split("\n");
    for (const pkg of suspects.keys()) {
      const re = new RegExp(`(?:require\\s*\\(|from|import\\s*\\()\\s*["']${esc(pkg)}(?:/[^"']*)?["']`);
      const at = lines.findIndex((t) => re.test(t));
      if (at >= 0) add("dependency-reaches-signer", file, at + 1, `${file} imports suspect package ${pkg} and handles signer material (${suspects.get(pkg).join(", ")}). Static match only.`, null, { package: pkg });
    }
  }
}

export function cryptoLeads(snapshot) {
  const leads = [];
  const add = (check, file, line, description, secret, extra = {}) => {
    const summary = secret ? redactSecret(secret) : undefined;
    leads.push({ engine: "Touchstone", check, impact: ["crypto-package-lookalike", "dependency-not-in-lockfile"].includes(check) ? "Low" : "High",
      file, lines: [line], where: { file, line, ...(summary ? { fingerprint: summary.sha256 } : {}), ...(extra.package ? { package: extra.package } : {}) }, description,
      ...(summary ? { secret: summary } : {}), ...extra });
  };
  for (const [file, source] of Object.entries(snapshot.files)) {
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      // A random bytes32 is not necessarily a key. Require key/account context.
      if (/(private[_-]?key|deployer|accounts|secret[_-]?key)/i.test(text)) {
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
      if (file.endsWith("package.json")) {
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
