import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { captureSnapshot, makeLabWorkspace } from "./snapshot.mjs";
import { runCloudPosture } from "./cloud.mjs";
const ws = makeLabWorkspace();
try {
  const snapshot = captureSnapshot(ws);
  const risky = await runCloudPosture(snapshot);
  assert.equal(risky.status, "ok", JSON.stringify(risky));
  assert.deepEqual({ versioning: risky.liveConfig.versioning, objectLock: risky.liveConfig.objectLock }, { versioning: "Suspended", objectLock: false });
  assert.ok(risky.findings.some((f) => f.check === "s3_bucket_object_versioning" && f.status === "FAIL"));
  assert.ok(risky.findings.some((f) => f.check === "s3_bucket_object_lock" && f.status === "FAIL"));
  const fixed = structuredClone(snapshot);
  const tf = JSON.parse(fixed.files["main.tf.json"]);
  tf.resource.aws_s3_bucket.frontend.acl = "private";
  tf.resource.aws_s3_bucket.frontend.object_lock_enabled = true;
  tf.resource.aws_s3_bucket_versioning.frontend.versioning_configuration.status = "Enabled";
  fixed.files["main.tf.json"] = JSON.stringify(tf);
  const safe = await runCloudPosture(fixed);
  assert.equal(safe.status, "ok", JSON.stringify(safe));
  assert.ok(safe.findings.some((f) => f.check === "s3_bucket_public_write_acl" && f.status === "PASS"));
  assert.ok(safe.findings.some((f) => f.check === "s3_bucket_object_versioning" && f.status === "PASS"));
  assert.deepEqual(safe.liveConfig, { versioning: "Enabled", objectLock: true, publicWriteAcl: false });
  mkdirSync(new URL("./validation/", import.meta.url), { recursive: true });
  writeFileSync(new URL("./validation/cloud-posture.json", import.meta.url), JSON.stringify({ risky, safe }, null, 2) + "\n");
  console.log(JSON.stringify({ smoke: "pass", risky, safe }, null, 2));
} finally { rmSync(ws, { recursive: true, force: true }); }
