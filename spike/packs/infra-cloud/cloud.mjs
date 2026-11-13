import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool } from "../../lib/wrap.mjs";
import { createLabNetwork, removeLabNetwork } from "../../lib/lab-net.mjs";
import { parseResources } from "./checks.mjs";

export function cloudSeed(snapshot) {
  const rs = parseResources(snapshot).resources;
  const buckets = rs.filter((r) => r.type === "aws_s3_bucket" && r.data.tags?.["touchstone-role"] === "frontend");
  if (buckets.length !== 1) throw new Error("The moto lab requires one explicitly tagged front-end bucket");
  const bucket = buckets[0];
  if (!/^touchstone-lab-[a-z0-9-]+$/.test(bucket.data.bucket ?? "")) throw new Error("Only throwaway lab bucket names are allowed");
  const versioning = rs.find((r) => r.type === "aws_s3_bucket_versioning" && r.data.bucket === `\${aws_s3_bucket.${bucket.name}.id}`)?.data.versioning_configuration;
  const status = (Array.isArray(versioning) ? versioning[0] : versioning)?.status ?? "Suspended";
  if (!["Enabled", "Suspended"].includes(status) || !["private", "public-read", "public-read-write"].includes(bucket.data.acl)) throw new Error("Unresolved bucket settings cannot seed the lab");
  const block = rs.find((r) => r.type === "aws_s3_bucket_public_access_block" && r.data.bucket === `\${aws_s3_bucket.${bucket.name}.id}`)?.data ?? {};
  const publicAccessBlock = Object.fromEntries([["block_public_acls", "BlockPublicAcls"], ["block_public_policy", "BlockPublicPolicy"], ["ignore_public_acls", "IgnorePublicAcls"], ["restrict_public_buckets", "RestrictPublicBuckets"]].map(([key, api]) => [api, block[key] === true]));
  return { bucket: bucket.data.bucket, acl: bucket.data.acl, versioning: status, objectLock: bucket.data.object_lock_enabled === true, publicAccessBlock };
}

export async function runCloudPosture(snapshot) {
  let seed;
  try { seed = cloudSeed(snapshot); } catch { return { engine: "prowler", status: "unavailable", reason: "Snapshot has no supported literal moto lab seed" }; }
  const network = `touchstone-infra-moto-${process.pid}-${Date.now()}`;
  const ws = mkdtempSync(join(tmpdir(), "infra-moto-"));
  const docker = (args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
  let server, container, networkCreated = false;
  try {
    cpSync(new URL("./cloud-seed.py", import.meta.url), join(ws, "cloud-seed.py"));
    writeFileSync(join(ws, "seed.json"), JSON.stringify(seed));
    const made = await createLabNetwork(network, ["--internal"]);
    if (made.code !== 0) throw new Error(made.stderr);
    networkCreated = true;
    server = runTool({ image: "motoserver/moto:5.2.5@sha256:59a1965d845249b04def37a0e2565f9cc6c44543cb89b68e90f28f344b3b0d1a", cmd: ["-p", "5000"], network, timeoutMs: 180000, env: { HOME: "/tmp" } });
    let endpoint, ready = false;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const entry = Object.entries(JSON.parse(docker(["network", "inspect", network]))[0].Containers ?? {})[0];
      if (entry) {
        container = entry[0];
        endpoint = `http://${entry[1].IPv4Address.split("/")[0]}:5000`;
        try { if ((await fetch(`${endpoint}/moto-api/`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) throw new Error("moto did not become ready");
    const r = await runTool({ image: "touchstone/prowler-python:5.48.0", cmd: ["/work/cloud-seed.py"], ws, network, timeoutMs: 150000,
      env: { HOME: "/tmp", AWS_ACCESS_KEY_ID: "testing", AWS_SECRET_ACCESS_KEY: "testing", AWS_DEFAULT_REGION: "us-east-1", AWS_ENDPOINT_URL: endpoint, AWS_EC2_METADATA_DISABLED: "true", AWS_SDK_LOAD_CONFIG: "false" } });
    const data = JSON.parse(r.stdout.trim());
    if (r.timedOut || !data.findings?.length || data.findings.some((f) => !f.check || !["PASS", "FAIL"].includes(f.status))) throw new Error("Prowler did not produce supported results");
    return { engine: "prowler", status: "ok", source: "private moto lab seeded from pinned IaC", seed, code: data.code, findings: data.findings, liveConfig: data.liveConfig };
  } catch { return { engine: "prowler", status: "error", reason: "Private moto/Prowler run did not return valid posture results" }; }
  finally {
    if (container) { try { docker(["stop", container]); } catch {} }
    if (server) await server;
    if (networkCreated) await removeLabNetwork(network);
    rmSync(ws, { recursive: true, force: true });
  }
}
