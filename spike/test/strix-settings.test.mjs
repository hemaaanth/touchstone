// The Web module's Strix limits: the turn cap, the per-scan budget and the
// time limit. A saved value wins over the server's env, and the env wins over
// the default. A bad value is refused on save and skipped on read.
// The saved config is this test's private file (isolated-env).
import "./helpers/isolated-env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const { STRIX_DEFAULTS, strixSettings, validateStrixSetting } = await import("../lib/strix.mjs");
const { providersFile, readConfig } = await import("../lib/providers.mjs");
const { getSettings, setStrixSettings } = await import("../../app/server/settings.mjs");

const ENV = ["STRIX_TURNS", "STRIX_BUDGET_USD", "STRIX_TIMEOUT_MS"];
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  rmSync(providersFile(), { force: true });
});

test("strix settings: defaults, then env, then saved", () => {
  assert.deepEqual(strixSettings({}), { ...STRIX_DEFAULTS, source: { turns: "default", budgetUsd: "default", timeoutMin: "default" } });
  process.env.STRIX_TURNS = "40";
  process.env.STRIX_TIMEOUT_MS = String(20 * 60_000);
  const env = strixSettings({});
  assert.equal(env.turns, 40);
  assert.equal(env.timeoutMin, 20);
  assert.equal(env.source.turns, "env");
  const saved = strixSettings({ modules: { web: { strix: { turns: 60 } } } });
  assert.equal(saved.turns, 60);
  assert.equal(saved.source.turns, "saved");
  assert.equal(saved.timeoutMin, 20, "a value not saved still comes from the env");
});

test("strix settings: a bad value is skipped on read", () => {
  process.env.STRIX_TURNS = "lots";
  const s = strixSettings({ modules: { web: { strix: { turns: 0, budgetUsd: -1 } } } });
  assert.equal(s.turns, STRIX_DEFAULTS.turns);
  assert.equal(s.budgetUsd, STRIX_DEFAULTS.budgetUsd);
  assert.equal(s.source.turns, "default");
});

test("strix settings: validation", () => {
  assert.equal(validateStrixSetting("turns", "30"), 30);
  assert.throws(() => validateStrixSetting("turns", 2.5), /whole number from 1 to 200/);
  assert.throws(() => validateStrixSetting("turns", 201), /1 to 200/);
  assert.throws(() => validateStrixSetting("budgetUsd", 0), /budget/i);
  assert.throws(() => validateStrixSetting("timeoutMin", 500), /time limit/i);
});

test("strix settings: save, show and clear through the settings API", () => {
  const before = getSettings().modules.web.strix;
  assert.equal(before.turns, STRIX_DEFAULTS.turns);
  assert.deepEqual(before.defaults, STRIX_DEFAULTS);

  const after = setStrixSettings({ turns: 50, budgetUsd: 1.25 }).modules.web.strix;
  assert.equal(after.turns, 50);
  assert.equal(after.budgetUsd, 1.25);
  assert.equal(after.source.turns, "saved");
  assert.equal(after.timeoutMin, STRIX_DEFAULTS.timeoutMin);
  assert.deepEqual(readConfig().modules.web.strix, { turns: 50, budgetUsd: 1.25 });

  // A bad value saves nothing, not even the good one beside it.
  assert.throws(() => setStrixSettings({ turns: 999, timeoutMin: 10 }), /1 to 200/);
  assert.deepEqual(readConfig().modules.web.strix, { turns: 50, budgetUsd: 1.25 });

  // null clears one value; the others stay.
  const cleared = setStrixSettings({ turns: null }).modules.web.strix;
  assert.equal(cleared.turns, STRIX_DEFAULTS.turns);
  assert.equal(cleared.source.turns, "default");
  assert.equal(cleared.budgetUsd, 1.25);
});
