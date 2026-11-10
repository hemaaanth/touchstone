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
function hasLocalSource(target) {
  return target.kind === "lab" || target.kind === "local-source";
}

// Compute the plan. `requested`, when given, is the set of toggleable module ids
// the operator wants on; omit it to default every available module on. Fixed
// modules (agent, replay) ignore it.
export function planModules(target, requested) {
  const want = (id, def) => (Array.isArray(requested) ? requested.includes(id) : def);
  const local = hasLocalSource(target);
  const mods = [];

  mods.push({ id: "agent", on: true, fixed: true, available: true, reason: "The agent always runs." });

  // A pack other than Contracts brings its own tools and its own proof. The
  // Solidity static and fuzz engines do not apply, so the plan is just the agent
  // and the pack's proof step. Pack tools that run before the agent report on
  // their own events.
  if (target.pack && target.pack !== "contracts") {
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

  if (target.kind === "brief") {
    mods.push({ id: "fetch", on: true, available: true, reason: "fetches the brief's linked sources into the workspace" });
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
