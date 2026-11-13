// Lab release folder for the cosign check. Throwaway keys, made fresh per lab.
//   release/wallet-cli.js   signed with the pinned key        -> cosign: Verified OK
//   release/install.sh      no bundle                          -> unsigned lead
//   release/updater.js      signed with a different key        -> invalid signature lead
// The bundle is the Sigstore bundle v0.3 JSON a key-based `cosign sign-blob`
// makes when no transparency log is used. Node signs it, so the lab needs no
// Docker and cosign checks a bundle it did not write itself.
// The private keys are never written. Only the pinned public key leaves, in the policy.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function signBundle(data, privateKey, publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return JSON.stringify({
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: { publicKey: { hint: createHash("sha256").update(der).digest("base64") } },
    messageSignature: { messageDigest: { algorithm: "SHA2_256", digest: createHash("sha256").update(data).digest("base64") }, signature: sign("sha256", data, privateKey).toString("base64") },
  }, null, 2) + "\n";
}

export const newKey = () => generateKeyPairSync("ec", { namedCurve: "P-256" });

export function makeCosignLab(ws) {
  const pinned = newKey(), other = newKey();
  const files = {
    "release/wallet-cli.js": "// Throwaway lab release. Signed with the pinned lab key.\nconsole.log(\"wallet-cli 1.0.0\");\n",
    "release/install.sh": "#!/bin/sh\n# Throwaway lab installer. Released with no signature.\necho \"install wallet-cli 1.0.0\"\n",
    "release/updater.js": "// Throwaway lab updater. Signed with a key that is not the pinned key.\nconsole.log(\"updater 1.0.0\");\n",
  };
  mkdirSync(join(ws, "release"), { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(ws, f), text);
  writeFileSync(join(ws, "release/wallet-cli.js.sigstore.json"), signBundle(Buffer.from(files["release/wallet-cli.js"]), pinned.privateKey, pinned.publicKey));
  writeFileSync(join(ws, "release/updater.js.sigstore.json"), signBundle(Buffer.from(files["release/updater.js"]), other.privateKey, other.publicKey));
  return { publicKey: pinned.publicKey.export({ type: "spki", format: "pem" }), artifacts: Object.keys(files) };
}
