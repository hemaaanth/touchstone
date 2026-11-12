// Settings for the execution backend (app/server/settings.mjs). These tests
// only read Settings, or fail before a write, so the saved file never changes.
import { test } from "node:test";
import assert from "node:assert/strict";

const { getSettings, setExecution } = await import("../../app/server/settings.mjs");

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test("getSettings shows the execution backend with a masked key", () => {
  const fake = "dtn_test_key_value_9z8y";
  withEnv({ DAYTONA_API_KEY: fake, TOUCHSTONE_EXEC: "daytona" }, () => {
    const s = getSettings();
    assert.ok(!JSON.stringify(s).includes(fake), "the key must not leave the server");
    assert.equal(s.execution.backend, "daytona");
    assert.equal(s.execution.envOverride, "daytona");
    if (s.execution.key.source === "env") {
      assert.equal(s.execution.key.last4, "9z8y");
    }
    assert.equal(s.execution.key.set, true);
  });
});

test("getSettings defaults to local Docker", () => {
  withEnv({ DAYTONA_API_KEY: undefined, TOUCHSTONE_EXEC: undefined }, () => {
    const s = getSettings();
    if (!s.execution.key.set) assert.equal(s.execution.backend, "local");
    assert.equal(typeof s.execution.target, "string");
  });
});

test("setExecution rejects a bad backend and Daytona with no key, before any write", () => {
  withEnv({ DAYTONA_API_KEY: undefined, TOUCHSTONE_EXEC: undefined }, () => {
    assert.throws(() => setExecution({ backend: "cloud" }), /backend must be/);
    assert.throws(() => setExecution({ backend: "local", target: "us west; rm" }), /bad characters/);
    if (!getSettings().execution.key.set) assert.throws(() => setExecution({ backend: "daytona" }), /needs an API key/);
  });
});
