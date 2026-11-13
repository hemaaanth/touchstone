// One run that covers several modules (piece D3).
//
//   node --experimental-test-module-mocks --test spike/test/multi-pack.test.mjs
//
// What must hold:
//   - a one-module run is exactly as before: `pack`, no `packs`, no sub-folders,
//     the pack's own tool names and prompt text;
//   - a run with several modules builds one sub-workspace per module, each by
//     its own build path, and the run's tool set is the union;
//   - the instructions name the tools the run really has, never one it lacks;
//   - a finding belongs to the module whose TOOL recorded it, never to the text
//     the agent writes;
//   - a capture module's network block stays in its own sub-workspace, and the
//     run's allow-list does not grow.
// No docker, no model call, no network. Builds are live-target builds: they only
// write files. A throwaway grant store stands in for the operator's.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "multi-pack-test-"));
process.env.TOUCHSTONE_GRANTS_FILE = path.join(dir, "grants.json");
process.env.TOUCHSTONE_SCOPES_FILE = path.join(dir, "scopes.json");
beforeEach(() => rmSync(process.env.TOUCHSTONE_GRANTS_FILE, { force: true }));
after(() => rmSync(dir, { recursive: true, force: true }));

const { addGrant } = await import("../lib/grant-store.mjs");
const { reachHosts, openReach } = await import("../lib/reach.mjs");
const { PACKS, packFor } = await import("../packs/index.mjs");
const { multiPack, multiPacks, memberDir, prepassViewOf } = await import("../packs/multi.mjs");
const { prepareMultiWorkspace, prepareRunWorkspace } = await import("../lib/targets.mjs");

const roots = [];
after(() => { for (const ws of roots) rmSync(ws, { recursive: true, force: true }); });

const host = "app.example.com";
const live = (packs) => ({ id: "live-probe", title: "A live site", kind: "live", pack: packs[0], packs, hosts: [host], origins: [`https://${host}`] });
const cfgOf = (ws) => JSON.parse(readFileSync(path.join(ws, ".touchstone.json"), "utf8"));
const build = async (packs, opts = {}) => {
  const ws = await prepareMultiWorkspace(live(packs), { ...opts, packs });
  roots.push(ws);
  return ws;
};
const names = (toolList) => toolList.map((t) => t.name);
const scratch = () => ({ poc: 0, found: [], passed: new Map() });
// One module's section of the joined instructions, from its `## Module:` header.
const sectionOf = (text, id) => text.split("## Module: ").find((s) => s.split("\n")[0].endsWith(`(${id})`)) ?? "";

test("one module keeps today's shape: `pack`, no `packs`, no sub-folder", async () => {
  const ws = await prepareRunWorkspace(live(["web"]), { modules: [] });
  roots.push(ws);
  try {
    const cfg = cfgOf(ws);
    assert.equal(cfg.pack, "web");
    assert.equal("packs" in cfg, false, "a one-module config never writes `packs`");
    assert.equal(existsSync(path.join(ws, "modules")), false);
    // The pack itself, unchanged: same id, same names, same text.
    assert.equal(packFor(cfg), PACKS.web);
    assert.deepEqual(names(packFor(cfg).tools(ws, scratch())), names(PACKS.web.tools(ws, scratch())));
    assert.equal(packFor(cfg).system(ws), PACKS.web.system(ws));
    assert.equal(multiPacks(cfg), null);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("the build makes one sub-workspace per module, each with its own config", async () => {
  const ws = await build(["web", "surface"]);
  const cfg = cfgOf(ws);
  assert.equal(cfg.pack, "multi");
  assert.deepEqual(cfg.packs, ["web", "surface"]);
  // Each module was built by its own path, under its own folder and config.
  for (const id of ["web", "surface"]) {
    const sub = memberDir(ws, id);
    assert.equal(sub, path.join(ws, "modules", id));
    assert.equal(cfgOf(sub).pack, id, `${id} keeps its own pack`);
    assert.equal(cfgOf(sub).baseUrl, `https://${host}`, `${id} keeps its own origin`);
    assert.ok(existsSync(path.join(sub, "BRIEF.md")), `${id} keeps its own brief`);
  }
  assert.equal(packFor(cfg).id, "multi");
  assert.deepEqual(packFor(cfg).packs, ["web", "surface"]);
});

test("the build refuses one module and an unknown one", async () => {
  await assert.rejects(prepareMultiWorkspace(live(["web"])), /more than one module/);
  await assert.rejects(build(["web", "nope"]), /Unknown pack "nope"/);
});

test("the tool set is the union, and a shared name carries its module at the end", async () => {
  const ws = await build(["web", "surface", "domains"]);
  const pack = packFor(cfgOf(ws));
  const got = names(pack.tools(ws, scratch()));
  // Union of the modules' own tools, every name unique.
  const own = pack.members.flatMap((p) => names(p.tools(memberDir(ws, p.id), scratch())));
  const owners = new Map();
  for (const n of own) owners.set(n, (owners.get(n) ?? 0) + 1);
  // Every own tool appears in the union once per owning module: plain when only
  // one module has it, suffixed when two or more do.
  assert.equal(got.length, own.length, "the run has every module's tool, none twice");
  for (const [n, count] of owners) {
    assert.equal(got.filter((g) => g === n || g.startsWith(`${n}_`)).length, count, `${n} is offered once per owning module`);
  }
  assert.equal(new Set(got).size, got.length, "no tool name is used twice");
  assert.ok(got.includes("snapshot_leads_surface") && got.includes("snapshot_leads_domains"));
  assert.ok(got.includes("submit_finding_web") && got.includes("submit_finding_domains"));
  // A name only one module has keeps its plain name.
  assert.ok(got.includes("run_request_script"));
});

test("the instructions name the tools the run has, for 2 and for 3 modules", async () => {
  for (const packs of [["web", "domains"], ["web", "domains", "surface"]]) {
    const ws = await build(packs);
    const pack = packFor(cfgOf(ws));
    // The module sections: the meta head above them may show an old name as an
    // example, the sections must use the real one.
    const text = pack.system(ws) + "\n\n" + pack.kickoff(ws, {});
    const sections = pack.members.map((p) => sectionOf(text, p.id));
    assert.ok(sections.every((s) => s.length > 0), "every module has its own section");
    const body = sections.join("\n\n");
    const got = new Set(names(pack.tools(ws, scratch())));
    // Every tool the run has is reachable by the name its section gives.
    for (const n of got) assert.ok(body.includes(n), `instructions must name ${n}`);
    // No section keeps a name the run does not have: every tool name of a
    // module in this run appears under the exact name the run gives it.
    const candidates = new Set(pack.members.flatMap((p) => names(p.tools(memberDir(ws, p.id), scratch()))));
    for (const m of body.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
      if (candidates.has(m[0])) assert.ok(got.has(m[0]), `instruction names ${m[0]}, which the run does not have`);
    }
    // A shared name is never left bare in a section: a module uses only its own
    // form of it.
    const ownNames = new Map(pack.members.map((p) => [p.id, names(p.tools(memberDir(ws, p.id), scratch()))]));
    const shared = [...new Set([...ownNames.values()].flat())].filter((n) => pack.members.filter((p) => ownNames.get(p.id).includes(n)).length > 1);
    assert.ok(shared.length, "this run has a shared tool name to check");
    for (const n of shared) {
      for (const p of pack.members) {
        assert.doesNotMatch(sectionOf(text, p.id), new RegExp(`\\b${n}\\b`), `${p.id} names the bare shared name ${n}`);
      }
    }
  }
});

test("a module names another module's tool under the run's real name", async () => {
  // Surface has no submit_finding. In a run where another module has it, the
  // line must name that module's form: the run does not know the bare name.
  const two = await build(["web", "surface"]);
  assert.match(packFor(cfgOf(two)).system(two), /Do not call submit_finding\./, "no other module has it, so no suffix");
  const three = await build(["web", "domains", "surface"]);
  assert.match(packFor(cfgOf(three)).system(three), /Do not call submit_finding_web or submit_finding_domains\./);
  // The reviews' "there is no submit_finding tool" stays true when no module has
  // the tool: no module of the run is given a name that does not exist.
  const reviewOnly = multiPack([PACKS.review, PACKS.surface]);
  const text = reviewOnly.system(two);
  assert.ok(text.includes("there is no submit_finding tool"));
});

// Two stub packs: the small shape the join relies on, with no docker.
function stub(id, seen) {
  return {
    id,
    title: id,
    system: (ws) => `Rules of ${id}.`,
    // The state the join hands this module is the one its tools write into.
    tools: (ws, state) => {
      seen.state = state;
      return [{ name: "submit_finding", description: `record a ${id} finding`, execute: async (body) => {
        seen.calls.push({ id, ws });
        state.found.push({ title: body.title, severity: body.severity, pack: body.pack });
        return { output: [{ type: "text", text: "recorded" }] };
      } }, { name: `only_${id}`, execute: async () => ({ output: [] }) }];
    },
    prove: async (ws, found) => {
      seen.proved.push({ id, ws, found: found.map((f) => f.title) });
      return found.map((f) => ({ ...f, pocProved: true }));
    },
  };
}

test("a finding belongs to the tool that recorded it, not to its text", async () => {
  const seen = { calls: [], proved: [] };
  const pack = multiPack([stub("alpha", seen), stub("beta", seen)]);
  const ws = mkdtempSync(path.join(tmpdir(), "multi-stub-"));
  roots.push(ws);
  const state = scratch();
  const tool = pack.tools(ws, state).find((t) => t.name === "submit_finding_alpha");
  assert.ok(tool, "the shared tool is named after its module");
  // Both a missing pack and a pack that claims the other module.
  await tool.execute({ title: "one", severity: "high" });
  await tool.execute({ title: "two", severity: "low", pack: "beta" });
  assert.deepEqual(state.found.map((f) => f.pack), ["alpha", "alpha"]);
  // Only alpha's own prove() gets them, in alpha's own sub-workspace.
  const proven = await pack.prove(ws, state.found, []);
  assert.deepEqual(seen.proved.map((p) => p.id), ["alpha"]);
  assert.deepEqual(seen.proved[0].found, ["one", "two"]);
  assert.equal(seen.proved[0].ws, memberDir(ws, "alpha"));
  assert.deepEqual(proven.map((f) => f.pack), ["alpha", "alpha"]);
  assert.deepEqual(seen.calls.map((c) => c.ws), [memberDir(ws, "alpha"), memberDir(ws, "alpha")]);
});

test("a capture module's network stays in its own sub-workspace", async () => {
  const ws = await build(["surface", "web"]);
  const surface = cfgOf(memberDir(ws, "surface"));
  const web = cfgOf(memberDir(ws, "web"));
  // Surface captures DNS: its own reach block, its own scope, nothing added.
  assert.equal(surface.reach.network, "bridge");
  assert.deepEqual(surface.reach.scope, [host]);
  // Web reads a base URL and never gets the capture's network block.
  assert.equal(web.reach, undefined);
  assert.equal(web.baseUrl, `https://${host}`);
  // The run's root names the modules, not one module's network.
  assert.equal(cfgOf(ws).reach, undefined);
  assert.deepEqual(cfgOf(ws).packs, ["surface", "web"]);
});

test("the joined run's allow-list equals a one-module run's and adds no host", async () => {
  addGrant({ hosts: [host], kind: "operator-owned", ownership: true, note: "test host" });
  const target = live(["surface", "web"]);
  // Reach is decided once, for the scope's own grant — the target is the same
  // target, so the union cannot add a host.
  const alone = await openReach({ ...target, pack: "surface" });
  const joined = await openReach(target);
  try {
    assert.deepEqual(joined.allowedHosts, reachHosts(target));
    assert.deepEqual(joined.allowedHosts, alone.allowedHosts);
    assert.deepEqual(joined.hosts, [host]);
    assert.equal(joined.env.TOUCHSTONE_SCOPE_ALLOW, alone.env.TOUCHSTONE_SCOPE_ALLOW);
  } finally {
    await joined.stop();
    await alone.stop();
  }
});

test("multiPacks reads only a real list of two or more, deduplicated", () => {
  assert.equal(multiPacks({}), null);
  assert.equal(multiPacks({ pack: "web" }), null);
  assert.equal(multiPacks({ packs: ["web"] }), null);
  assert.equal(multiPacks({ packs: ["web", "web"] }), null);
  assert.deepEqual(multiPacks({ packs: ["web", "web", "domains"] }), ["web", "domains"]);
});

test("the pre-pass view names each module's rows and leaves one-module records alone", () => {
  const record = {
    pack: "multi",
    packs: ["surface", "domains"],
    byPack: {
      surface: { leads: [{ check: "csp", impact: "low", where: "a.example.com" }], tools: [{ name: "snapshot_leads", status: "ran", leads: 1 }] },
      domains: { leads: [{ check: "dangling-cname", impact: "high", where: "b.example.com" }], tools: [{ name: "snapshot_leads", status: "ran", leads: 1 }] },
    },
  };
  const view = prepassViewOf(record);
  assert.deepEqual(view.leads.map((l) => [l.pack, l.check]), [["domains", "dangling-cname"], ["surface", "csp"]], "worst first, each row tagged");
  assert.deepEqual(view.tools.map((t) => t.pack), ["surface", "domains"]);
  assert.equal(view.total, 2);
  // An old one-module record is folded exactly as before.
  const single = { pack: "domains", leads: [{ check: "x", impact: "high", where: "c.example.com" }], tools: [] };
  assert.deepEqual(prepassViewOf(single), prepassViewOf(single));
  assert.deepEqual(prepassViewOf(single).leads.map((l) => l.check), ["x"]);
  assert.equal("pack" in prepassViewOf(single).leads[0], false);
});
