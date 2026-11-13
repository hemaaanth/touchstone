// The module plan for a run — which parts of the pipeline are on, and why.
//
// WHY THIS EXISTS. The operator selects and deselects modules per run. But a
// module is not always a free choice: the static analyzers and the property
// fuzzers need local Solidity source to scan, and a brief has none until its
// linked code is fetched during the run. So the plan is computed from the scope,
// not just from what was requested: a module the scope cannot support is off with
// a reason, never silently dropped. Two modules are never toggleable — the agent
// always runs, and the Foundry replay is the only thing that makes a finding
// real, so it is always the gate.
//
// The plan is emitted as one `modules` event at run start (so the UI shows the
// honest on/off state, including an explicit "off, because…"), and is stored in
// the workspace config so the agent child and the decide child agree on which
// tools exist across a resume.

// Does this scope ship local source the static/fuzz engines can scan at run
// start? A lab does; a local-source folder will; a brief does not (it fetches).
// A scope does when one of its folders has Solidity: those are the only files
// the Solidity engines can scan.
function hasLocalSource(target) {
  if (target.kind === "scope") return (target.members ?? []).some((m) => m.kind === "folder" && m.files?.some((f) => String(f.path ?? f).endsWith(".sol")));
  return target.kind === "lab" || target.kind === "local-source";
}

// Does the run fetch code at run time? A brief fetches its links; a scope
// fetches its repo members.
function fetches(target) {
  return target.kind === "brief" || (target.kind === "scope" && (target.links ?? []).length > 0);
}

// Compute the plan. `requested`, when given, is the set of toggleable module ids
// the operator wants on; omit it to default every available module on. Fixed
// modules (agent, replay) ignore it. `pack` is the run's pack manifest, when the
// caller has it. A pack with `proof: "none"` gets its replay step off.
// `chosen` is every module the run covers (one id, or the whole list of a joined
// run). A joined run is only as provable as its best module: replay stays on
// when ANY module can prove, and only a run made of proof-less modules gets it
// off. The legacy path with no `chosen` reads `target.pack` alone.
export function planModules(target, requested, pack, chosen) {
  const packs = Array.isArray(chosen) && chosen.length ? [...new Set(chosen)] : [target.pack];
  const only = (id) => packs.every((p) => p === id);
  const want = (id, def) => (Array.isArray(requested) ? requested.includes(id) : def);
  const local = hasLocalSource(target);
  const mods = [];

  mods.push({ id: "agent", on: true, fixed: true, available: true, reason: "The agent always runs." });

  // A pack other than Contracts brings its own tools and its own proof. The
  // Solidity static and fuzz engines do not apply, so the plan is just the agent
  // and the pack's proof step. Pack tools that run before the agent report on
  // their own events.
  // The review pack has no replay oracle that fits its code. Say so: replay is
  // off and cannot be turned on, so no finding from this run is ever proven.
  if (only("review")) {
    if (fetches(target)) mods.push({ id: "fetch", on: true, fixed: true, available: true, reason: "fetches the scope's repos into the workspace" });
    mods.push({ id: "replay", on: false, fixed: true, available: false, reason: "No replay oracle fits this code, so no finding can be proven. The run reports leads only." });
    return mods;
  }

  if (!only("contracts")) {
    if (pack?.proof === "none") {
      mods.push({ id: "replay", on: false, fixed: true, available: false, reason: "This module has no replay oracle, so no finding can be proven. The run reports leads only." });
      return mods;
    }
    mods.push({ id: "replay", on: true, fixed: true, available: true, reason: "The pack's proof step is the only thing that makes a finding real." });
    return mods;
  }

  if (local) {
    mods.push({ id: "static", on: want("static", true), available: true, reason: null });
    mods.push({ id: "fuzz", on: want("fuzz", true), available: true, reason: null });
  } else {
    mods.push({ id: "static", on: false, available: false, reason: "no local source at start — a static analyzer has nothing to scan until the brief's code is fetched" });
    mods.push({ id: "fuzz", on: false, available: false, reason: "no local source at start — there is nothing to fuzz until the brief's code is fetched" });
  }

  if (fetches(target)) {
    mods.push({ id: "fetch", on: true, available: true, reason: target.kind === "scope" ? "fetches the scope's repos into the workspace" : "fetches the brief's linked sources into the workspace" });
  }

  mods.push({ id: "replay", on: true, fixed: true, available: true, reason: "A Foundry replay is the only thing that makes a finding real." });
  return mods;
}

// True when a module id is present and on in a plan.
export function moduleOn(modules, id) {
  return Array.isArray(modules) && modules.some((m) => m.id === id && m.on);
}

// The `modules` event for the stream — just the id/on/reason the UI needs.
export function modulesEvent(modules) {
  return {
    t: Date.now(),
    ev: "modules",
    modules: modules.map((m) => ({ id: m.id, on: m.on, available: m.available !== false, fixed: Boolean(m.fixed), reason: m.reason ?? null })),
  };
}
