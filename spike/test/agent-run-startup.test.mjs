import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { currentAgent } from "../lib/event.mjs";
import { roamBrowserTools } from "../lib/roam-browser.mjs";
import { createRoamControl } from "../lib/roam-control.mjs";
import { captureSessionArtifacts } from "../lib/session-artifacts.mjs";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createFleet } from "../lib/fleet.mjs";
import { askHumanTool } from "../lib/ask.mjs";
import { ideaTool } from "../lib/candidate.mjs";
import { roamTools } from "../lib/roam.mjs";
import { candidateTool, recordSession, sessionLookup, SESSION_DESCRIPTION, SESSION_POC } from "../lib/candidate.mjs";
import { EGRESS_ENV } from "../lib/roam-egress.mjs";

// Run exact startup code with real fleet/registry/storage, not provider bootstrap.
const source = readFileSync(new URL("../agent-run.mjs", import.meta.url), "utf8");
const body = source.slice(source.indexOf("function createRuntimeRoam("), source.indexOf("// The record keeps"));

function startup(t, raw, failure, overrides = {}) {
  const env = { FLEET: "1", FREE_ROAM: "1", ROAM_OPTIONS: raw, TOUCHSTONE_EXEC: "daytona", DAYTONA_API_KEY: "made-up-startup-test-key", DAYTONA_API_URL: undefined, TOUCHSTONE_DEMO: undefined, ...overrides };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const set = (values) => { for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  set(env);
  t.after(() => set(previous));
  const order = [], sharedNames = [];
  const models = createModels();
  const faux = fauxProvider();
  faux.setResponses([() => assert.fail("startup must not generate a model turn")]);
  models.setProvider(faux.provider);
  const pack = { id: "startup-test", system: () => "Audit the lab only.", tools: () => [] };
  const noRemote = () => assert.fail("startup must not open a remote machine");
  let fleet, harness;
  t.after(async () => { await fleet?.close(); await harness?.close(ctx); });
  const open = runInNewContext(`${body}; openHarness`, {
    process: { env: process.env }, ctx, path, randomUUID, currentAgent,
    roamBrowserTools, createRoamControl, captureSessionArtifacts, roamMachine: noRemote, event: noRemote,
    packFor: () => pack,
    readTouchstone: () => { order.push("workspace"); return {}; },
    DIAGRAM_RULE: "", scopeInstructions: () => "",
    createRegistry, defineExtension,
    createFleet: (args) => {
      order.push("fleet");
      sharedNames.push(...args.sharedTools.map((tool) => tool.name));
      fleet = createFleet(args);
      const attach = fleet.attach.bind(fleet), close = fleet.close.bind(fleet);
      fleet.attach = async (...args) => { order.push("attach"); if (failure === "attach") throw new Error("attach test failure"); return attach(...args); };
      fleet.close = async () => { order.push("fleet-close"); return close(); };
      return fleet;
    },
    Harness: { open: async (...args) => {
      order.push("harness");
      harness = await Harness.open(...args);
      const root = harness.root.bind(harness), close = harness.close.bind(harness);
      harness.root = async (...args) => {
        order.push("root");
        if (failure === "root") throw new Error("root test failure");
        // The VM has a different Array prototype; durable documents require host-realm JSON arrays.
        if (args[1]?.agent?.tools?.remove) args[1].agent.tools.remove = [...args[1].agent.tools.remove];
        return root(...args);
      };
      harness.close = async (...args) => { order.push("harness-close"); return close(...args); };
      return harness;
    } },
    openNodeSqliteStorage: async () => { order.push("storage"); return new MemoryStorage(); },
    inferenceModels: () => models,
    roamTools: (ws, options) => roamTools(ws, { ...options, machine: noRemote }),
    candidateTool, recordSession, sessionLookup, SESSION_DESCRIPTION, SESSION_POC,
    EGRESS_ENV, startEgressLog: noRemote, pullEgressLog: noRemote,
    costOf: () => 0, briefChange: () => "", askHumanTool, ideaTool,
    PROVIDER_ID: "faux", MODELS: { fake: { id: "faux-1" } }, ALIAS: "fake",
    disposeAsks: () => order.push("dispose"),
  });
  return { order, sharedNames, open: () => open("memory-only", "fake-workspace", { passed: new Map(), found: [] }) };
}

for (const demo of [false, true]) test(`startup offers answerable shared tools: ${demo ? "public demo" : "owner"}`, async (t) => {
  const fixture = startup(t, "[]", undefined, demo ? { TOUCHSTONE_DEMO: "1", FREE_ROAM: "0", TOUCHSTONE_EXEC: "local", FLEET_MAX: "3" } : {});
  const opened = await fixture.open();
  assert.equal(fixture.sharedNames.includes(askHumanTool.name), !demo);
  assert.ok(fixture.sharedNames.includes(ideaTool({ passed: new Map(), found: [] }).name));
  await opened.control.dispose();
});

for (const raw of [undefined, "[]", "  [ ]  "]) test(`runner startup accepts empty options: ${String(raw)}`, async (t) => {
  const fixture = startup(t, raw);
  const opened = await fixture.open();
  assert.ok(opened.root);
  assert.ok(opened.fleet);
  assert.equal(typeof opened.control.handle, "function");
  await opened.control.dispose();
  assert.deepEqual(fixture.order, ["workspace", "fleet", "storage", "harness", "root", "attach"]);
  assert.equal(process.env.ROAM_OPTIONS, raw, "startup must not rewrite options");
});

for (const raw of ['["wallet"]', '["email"]', '["wallet","email"]', '["unknown"]', '[null]', "null", "{}", "false", "0", '"[]"', "", "not JSON"]) {
  test(`runner refuses unsupported or invalid options before opening: ${JSON.stringify(raw)}`, async (t) => {
    const fixture = startup(t, raw);
    await assert.rejects(fixture.open(), /ROAM_OPTIONS must be \[\]/);
    assert.deepEqual(fixture.order, [], "no workspace, fleet, storage or harness may open");
    assert.equal(process.env.ROAM_OPTIONS, raw, "refusal must not silently replace options");
  });
}

for (const failure of ["root", "attach"]) test(`empty-option startup retains ${failure} failure cleanup`, async (t) => {
  const fixture = startup(t, "[]", failure);
  await assert.rejects(fixture.open(), new RegExp(`${failure} test failure`));
  assert.deepEqual(fixture.order.slice(-3), ["dispose", "fleet-close", "harness-close"]);
});
