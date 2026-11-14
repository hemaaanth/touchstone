import "./helpers/isolated-env.mjs";
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { beginRoamOperation, daytonaStateFile, roamBinding, roamOperations, roamSelectionState, setRoamSelectionState, updateRoamOperation } from "../lib/daytona-state.mjs";

const dir = mkdtempSync(join(tmpdir(), "daytona-state-"));
process.env.TOUCHSTONE_DAYTONA_STATE_FILE = join(dir, "operations.json");
const config = { apiUrl: "https://fixture.test/api", apiKey: "synthetic-fixture-key", target: "fixture-region", roamSnapshot: "fixture-snapshot" };
const binding = roamBinding(config);
const slot = (name) => createHash("sha256").update(name).digest("hex");
beforeEach(() => rmSync(daytonaStateFile(), { force: true }));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a pending create survives reload and blocks a second create for the same child", async () => {
  const first = beginRoamOperation(config, "runtime", slot("run-1/child-1"));
  assert.equal(first.created, true);
  const restarted = await import(`../lib/daytona-state.mjs?restart=${Date.now()}`);
  const second = restarted.beginRoamOperation(config, "runtime", slot("run-1/child-1"));
  assert.equal(second.created, false);
  assert.equal(second.operation.id, first.operation.id);
  updateRoamOperation(binding, first.operation.id, "intent", "unknown");
  assert.equal(beginRoamOperation(config, "runtime", slot("run-1/child-1")).created, false);
});

test("independent child slots stay independent, including when one create is unknown", () => {
  const first = beginRoamOperation(config, "runtime", slot("child-0"));
  updateRoamOperation(binding, first.operation.id, "intent", "unknown");
  const others = Array.from({ length: 10 }, (_, i) => beginRoamOperation(config, "runtime", slot(`child-${i + 1}`)));
  assert.ok(others.every((r) => r.created));
  assert.equal(new Set(others.map((r) => r.operation.id)).size, 10);
  assert.equal(roamOperations(binding).length, 11);
});

test("configuration changes preserve outstanding obligations and cannot adopt another account's operation", () => {
  const first = beginRoamOperation(config, "snapshot", slot("setup"));
  const changed = roamBinding({ ...config, apiKey: "different-synthetic-key" });
  assert.notEqual(changed, binding);
  assert.throws(() => updateRoamOperation(changed, first.operation.id, "intent", "complete"), /New resource creation is blocked/);
  assert.equal(roamOperations(binding).length, 1);
  assert.equal(roamOperations(changed).length, 0);
  assert.ok(!readFileSync(daytonaStateFile(), "utf8").includes(config.apiKey));
});

test("unavailable readiness survives same-value configuration and unrelated operations", async () => {
  setRoamSelectionState(binding, "unavailable");
  beginRoamOperation(config, "probe", slot("probe"));
  const restarted = await import(`../lib/daytona-state.mjs?selection=${Date.now()}`);
  assert.equal(restarted.roamSelectionState(roamBinding({ ...config })).state, "unavailable");
  assert.equal(roamSelectionState(roamBinding({ ...config, target: "different-region" })), null);
});

test("a malformed existing journal is preserved and refuses all mutations", () => {
  for (const text of ["{", "{}", JSON.stringify([{ version: 999 }])]) {
    writeFileSync(daytonaStateFile(), text);
    assert.throws(() => beginRoamOperation(config, "runtime", slot("child")), /Daytona setup state is unavailable/);
    assert.throws(() => roamSelectionState(binding), /Daytona setup state is unavailable/);
    assert.equal(readFileSync(daytonaStateFile(), "utf8"), text);
  }
});

test("journal permissions remain private even with a permissive umask and existing mode", () => {
  const previous = process.umask(0);
  try {
    setRoamSelectionState(binding, "unavailable");
    assert.equal(statSync(daytonaStateFile()).mode & 0o777, 0o600);
    chmodSync(daytonaStateFile(), 0o666);
    beginRoamOperation(config, "runtime", slot("child"));
    assert.equal(statSync(daytonaStateFile()).mode & 0o777, 0o600);
  } finally { process.umask(previous); }
});

test("a stale asynchronous phase update cannot overwrite a newer result", () => {
  const { operation } = beginRoamOperation(config, "probe", slot("probe"));
  updateRoamOperation(binding, operation.id, "intent", "created", "sandbox-1");
  assert.throws(() => updateRoamOperation(binding, operation.id, "intent", "unknown"));
  assert.equal(roamOperations(binding)[0].phase, "created");
});

test("competing processes reserve one create while retaining all independent slots", async () => {
  const module = new URL("../lib/daytona-state.mjs", import.meta.url).href;
  const children = Array.from({ length: 4 }, (_, i) => {
    const code = `import {beginRoamOperation} from ${JSON.stringify(module)};
      const shared=beginRoamOperation(${JSON.stringify(config)},'runtime',${JSON.stringify(slot("shared"))});
      beginRoamOperation(${JSON.stringify(config)},'runtime',${JSON.stringify(slot(`independent-${i}`))});
      console.log(JSON.stringify(shared));`;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
        env: Object.fromEntries(["PATH", "TOUCHSTONE_DAYTONA_STATE_FILE", "TOUCHSTONE_GRANT_TOKEN", "TOUCHSTONE_GRANT_TOKEN_FILE", "TOUCHSTONE_PROVIDERS_FILE"].map((k) => [k, process.env[k]]).filter(([, v]) => v != null)),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "", error = "";
      child.stdout.on("data", (b) => output += b);
      child.stderr.on("data", (b) => error += b);
      child.on("error", reject);
      child.on("exit", (status) => status === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
    });
  });
  const results = await Promise.all(children);
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(new Set(results.map((r) => r.operation.id)).size, 1);
  assert.equal(roamOperations(binding).length, 5);
});
