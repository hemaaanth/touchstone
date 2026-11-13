// One run that covers several modules (packs).
//
// The operator can tick several modules for one scope. They run as ONE run: one
// agent session, one budget, one grant, one record. Each module keeps its own part:
//   - Its own workspace, `<ws>/modules/<id>`, with its own .touchstone.json. A
//     module's network setting (a capture's `reach`) is in its own file only, so
//     it never reaches another module's tools.
//   - Its own tools, bound to its own workspace. The run's tool set is the union.
//     A tool name that two modules share gets the module id at its end
//     (`submit_finding_web`), in the tool and in that module's own prompt text.
//   - Its own proof. Every finding a module's tool records carries `pack` (the
//     module id). Only that module's prove() replays it. The proven gate after
//     prove() is unchanged.
// A run with one module never comes here: packFor returns that module's pack.
import path from "node:path";
import { prepassView } from "../lib/prepass-view.mjs";

export const MULTI = "multi";
export const MULTI_DIR = "modules";

// The workspace of one module of a multi-module run.
export const memberDir = (ws, id) => path.join(ws, MULTI_DIR, id);

// The run's modules, from its workspace config. Null for a run with one module.
export function multiPacks(cfg = {}) {
  const ids = Array.isArray(cfg.packs) ? [...new Set(cfg.packs.map(String))] : [];
  return ids.length > 1 ? ids : null;
}

const slug = (id) => String(id).replace(/[^A-Za-z0-9_]/g, "_");
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The env key that carries one module's own pre-pass value.
const envKey = (id, key) => `TS_${slug(id).toUpperCase()}__${key}`;

// A Map view over the run's one `passed` map. Each module sees only its own keys.
function scopedMap(map, id) {
  const p = `${id}:`;
  const own = () => [...map.entries()].filter(([k]) => typeof k === "string" && k.startsWith(p)).map(([k, v]) => [k.slice(p.length), v]);
  const view = {
    get: (k) => map.get(p + k),
    has: (k) => map.has(p + k),
    set: (k, v) => (map.set(p + k, v), view),
    delete: (k) => map.delete(p + k),
    clear: () => own().forEach(([k]) => map.delete(p + k)),
    keys: () => own().map(([k]) => k)[Symbol.iterator](),
    values: () => own().map(([, v]) => v)[Symbol.iterator](),
    entries: () => own()[Symbol.iterator](),
    forEach: (fn) => own().forEach(([k, v]) => fn(v, k, view)),
    get size() { return own().length; },
    [Symbol.iterator]: () => own()[Symbol.iterator](),
  };
  return view;
}

// One module's view of the run's audit state. The findings list is shared, so
// numbering and duplicate checks span the run; a finding this module pushes is
// stamped with its module id. The rest (attempt counter) is the run's own.
function memberState(state, id) {
  const found = new Proxy(state.found, {
    get(list, key) {
      if (key === "push") {
        return (...items) => {
          // The tool decides the module; text the agent writes never does.
          for (const f of items) if (f && typeof f === "object") f.pack = id;
          return list.push(...items);
        };
      }
      const v = Reflect.get(list, key, list);
      return typeof v === "function" ? v.bind(list) : v;
    },
  });
  const passed = state.passed instanceof Map ? scopedMap(state.passed, id) : state.passed;
  return new Proxy(state, {
    get(s, key) {
      if (key === "found") return found;
      if (key === "passed") return passed;
      return Reflect.get(s, key, s);
    },
    set: (s, key, value) => Reflect.set(s, key, value, s),
  });
}

const scratchState = () => ({ poc: 0, found: [], passed: new Map() });

// Rewrite the tool names a module's text names to the names the run really has.
// Two cases, both from one list:
//   - the module's own tool: its own name, with the module id when the name is
//     shared with another module (`submit_finding_web`);
//   - a shared name the module does not have, but a module of this run does
//     ("Do not call submit_finding" in a module with no such tool): every form
//     the run does have, so no line names a tool the run lacks.
// Longest names first, so `list_sources` is not cut down to `list_source`.
function renamer(pairs) {
  if (!pairs.length) return (text) => text;
  const sorted = [...pairs].sort((a, b) => b[0].length - a[0].length);
  const re = new RegExp(`\\b(${sorted.map(([from]) => escape(from)).join("|")})\\b`, "g");
  const to = new Map(sorted);
  return (text) => (typeof text === "string" ? text.replace(re, (m) => to.get(m) ?? m) : text);
}

function renameResult(result, rename) {
  if (!result || !Array.isArray(result.output)) return result;
  return { ...result, output: result.output.map((o) => (o?.type === "text" && typeof o.text === "string" ? { ...o, text: rename(o.text) } : o)) };
}

const RANK = { critical: 0, high: 1, medium: 2, moderate: 2, low: 3, info: 4, informational: 4 };
const rank = (s) => RANK[String(s ?? "").toLowerCase()] ?? 5;

// The composite pack. `members` are the module packs, in the operator's order.
export function multiPack(members) {
  const ids = members.map((p) => p.id);
  const titles = members.map((p) => `${p.title ?? p.id} (${p.id})`);
  const views = new WeakMap(); // audit state -> Map(module id -> member state)
  const renames = new Map(); // ws -> Map(module id -> rename)

  const viewOf = (state, id) => {
    if (!state || typeof state !== "object") return state;
    if (!views.has(state)) views.set(state, new Map());
    const m = views.get(state);
    if (!m.has(id)) m.set(id, memberState(state, id));
    return m.get(id);
  };

  // Which names clash, and what each module's text calls them. Read from the
  // tool lists the modules build for their own workspaces; building a tool list
  // has no side effect.
  const renameFor = (ws, id) => {
    if (!renames.has(ws)) {
      const names = members.map((p) => new Set((p.tools?.(memberDir(ws, p.id), scratchState()) ?? []).map((t) => t.name)));
      const owners = new Map(); // tool name -> the module ids that have it
      names.forEach((set, i) => {
        for (const n of set) owners.set(n, [...(owners.get(n) ?? []), members[i].id]);
      });
      const own = (mid, n) => (owners.get(n).length > 1 ? `${n}_${slug(mid)}` : n);
      renames.set(ws, new Map(members.map((p) => [p.id, renamer([...owners].map(([n, who]) => {
        if (who.includes(p.id)) return [n, own(p.id, n)];
        // The module lacks the tool: point the line at the forms that exist.
        return [n, who.map((mid) => own(mid, n)).join(" or ")];
      }))])));
    }
    return renames.get(ws).get(id);
  };

  const section = (p, text) => `## Module: ${p.title ?? p.id} (${p.id})\n\n${text}`;

  return {
    id: MULTI,
    title: titles.join(" + "),
    packs: ids,
    members,

    system(ws) {
      const renamed = members.flatMap((p) => (p.tools?.(memberDir(ws, p.id), scratchState()) ?? [])
        .map((t) => [t.name, renameFor(ws, p.id)(t.name)]).filter(([from, to]) => from !== to));
      const example = renamed.length ? ` (for example ${renamed[0][0]} is called ${renamed[0][1]})` : "";
      const head = [
        `This run covers ${members.length} modules: ${titles.join(", ")}.`,
        "Each module has its own section below, with its own tools, its own rules and its own proof. Work every module.",
        `A tool belongs to the one module whose section names it. When two modules have a tool of the same name, each one carries its module id at the end of its name${example}. Use the exact name the module's own section gives.`,
        "A finding belongs to exactly one module. Record it with the tool of that module. Only that module's replay can prove it.",
      ].join("\n");
      return [head, ...members.map((p) => section(p, renameFor(ws, p.id)(p.system(memberDir(ws, p.id)))))].join("\n\n");
    },

    tools(ws, state) {
      return members.flatMap((p) => {
        const rename = renameFor(ws, p.id);
        return (p.tools?.(memberDir(ws, p.id), viewOf(state, p.id)) ?? []).map((t) => {
          const name = rename(t.name);
          if (name === t.name) return t;
          return { ...t, name, description: rename(t.description), execute: async (...args) => renameResult(await t.execute(...args), rename) };
        });
      });
    },

    kickoff(ws, env = {}) {
      const parts = members.map((p) => {
        const own = { ...env };
        const prefix = envKey(p.id, "");
        for (const [k, v] of Object.entries(env)) if (k.startsWith(prefix)) own[k.slice(prefix.length)] = v;
        return section(p, renameFor(ws, p.id)(p.kickoff(memberDir(ws, p.id), own)));
      });
      return [`This run covers ${members.length} modules. Do the task of each module below. Finish one module's task before you start the next.`, ...parts].join("\n\n");
    },

    // One nudge with each module's own nudge, or null when no module has one.
    // The nudge text names tools, so it gets the same names as the tools. The
    // workspace is not known here: a name is renamed when it was renamed for
    // any workspace of this run (there is one).
    nudge(state) {
      const parts = members.flatMap((p) => {
        const text = p.nudge?.(viewOf(state, p.id));
        if (!text) return [];
        const rename = [...renames.values()][0]?.get(p.id) ?? ((t) => t);
        return [section(p, rename(text))];
      });
      return parts.length ? parts.join("\n\n") : null;
    },

    // Each module's pre-pass in its own workspace, one after another. A module
    // whose pre-pass fails does not stop the others. The env: a key one module
    // sets goes through as is; a key several modules set (LEADS) goes through
    // only under each module's own name, and kickoff hands each module its own.
    async prepass(ws, opts = {}) {
      const done = [];
      const failed = [];
      for (const p of members) {
        if (typeof p.prepass !== "function") continue;
        try {
          done.push([p.id, (await p.prepass(memberDir(ws, p.id), opts)) ?? {}]);
        } catch (err) {
          failed.push([p.id, String(err?.message ?? err)]);
        }
      }
      if (!done.length && failed.length) throw new Error(failed.map(([id, e]) => `${id}: ${e}`).join("; "));
      const count = new Map();
      for (const [, r] of done) for (const k of Object.keys(r.env ?? {})) count.set(k, (count.get(k) ?? 0) + 1);
      const env = {};
      for (const [id, r] of done) {
        for (const [k, v] of Object.entries(r.env ?? {})) {
          env[envKey(id, k)] = v;
          if (count.get(k) === 1) env[k] = v;
        }
      }
      const byPack = Object.fromEntries(done.map(([id, r]) => [id, r.record ?? null]));
      // Only the module ids: a pre-pass error text can hold a secret.
      const record = { pack: MULTI, packs: ids, byPack, ...(failed.length ? { failed: failed.map(([id]) => id) } : {}) };
      // Contracts keeps its static and fuzz parts at the top, as a one-module run does.
      if (byPack.contracts?.static) record.static = byPack.contracts.static;
      if (byPack.contracts?.fuzz) record.fuzz = byPack.contracts.fuzz;
      return { env, record };
    },

    // Each finding goes to its own module's prove(), in that module's workspace.
    // A finding with no module (it did not come through a module's tool) is not
    // replayed by any module, so it is never proven.
    async prove(ws, found, events, log = () => {}) {
      const out = [];
      for (const p of members) {
        const mine = (found ?? []).filter((f) => f?.pack === p.id);
        if (!mine.length || typeof p.prove !== "function") continue;
        const proven = (await p.prove(memberDir(ws, p.id), mine, events, log)) ?? [];
        for (const f of proven) out.push({ ...f, pack: p.id });
      }
      const loose = (found ?? []).filter((f) => !ids.includes(f?.pack));
      if (loose.length) log(`${loose.length} finding(s) name no module of this run, so no module replays them`);
      return out.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f.severity) - rank(b.f.severity) || a.i - b.i).map((x) => x.f);
    },

    async teardown(ws) {
      for (const p of members) {
        try {
          await p.teardown?.(memberDir(ws, p.id));
        } catch {
          // Best effort, as for one module: the next module still stops.
        }
      }
    },
  };
}

// The run view's pre-pass fold. A multi-module record shows every module's
// tools and leads together, worst first. Each row names its module (`pack`), so
// the view says which module a lead came from. A one-module record is unchanged.
export function prepassViewOf(record) {
  if (record?.pack !== MULTI) return prepassView(record);
  const parts = Object.entries(record.byPack ?? {}).flatMap(([id, rec]) => {
    const view = prepassView(rec);
    return view ? [{ id, view }] : [];
  });
  if (!parts.length) return null;
  const tag = (rows) => parts.flatMap(({ id, view }) => rows(view).map((row) => ({ pack: id, ...row })));
  const leads = tag((v) => v.leads).map((l, i) => ({ l, i })).sort((a, b) => rank(a.l.impact) - rank(b.l.impact) || a.i - b.i).map((x) => x.l);
  return { total: parts.reduce((n, { view }) => n + view.total, 0), tools: tag((v) => v.tools).slice(0, 20), leads: leads.slice(0, 50) };
}
