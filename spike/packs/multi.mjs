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
//   - ONE fetched source tree. The scope's links are fetched once, into the run
//     root's `vendor/`, and copied into every module that reads code, so each
//     module's read tools work on its own paths and the coverage count sees one
//     `source-fetch` per link, not one per module.
// A run with one module never comes here: packFor returns that module's pack.
import path from "node:path";
import { cpSync, readdirSync } from "node:fs";
import { prepassView } from "../lib/prepass-view.mjs";
import { fetchSource } from "../lib/fetch.mjs";
import { concreteSolc, warmSolc } from "../lib/sandbox.mjs";
import { event } from "../lib/event.mjs";

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

// The env key that carries one module's own pre-pass value. `PRODUCED` names
// the plain keys any module's pre-pass set, so a plain key can be dropped for
// every module when the kickoff runs on another pack object.
const envKey = (id, key) => `TS_${slug(id).toUpperCase()}__${key}`;
const PRODUCED = "TS_JOINED__KEYS";

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
// the record keeps one list and one numbering; a finding this module pushes is
// stamped with its module id. Reads see ONLY this module's findings, because
// every pack's duplicate check is written as "is this root cause already mine?"
// (a shared list would refuse another module's finding that happens to use the
// same label). The attempt counter stays the run's own.
function memberState(state, id) {
  const push = (...items) => {
    // The tool decides the module; text the agent writes never does.
    for (const f of items) if (f && typeof f === "object") f.pack = id;
    return state.found.push(...items);
  };
  const found = new Proxy(state.found, {
    get(list, key) {
      if (key === "push") return push;
      // Prior findings from an older record (or a worker that died before the
      // tool stamped them) have no pack: they are visible to every module, so a
      // duplicate of one is still refused.
      const own = list.filter((f) => f?.pack === id || f?.pack == null);
      const v = own[key];
      return typeof v === "function" ? v.bind(own) : v;
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

// Every tool text the agent reads names tools: the description, each parameter
// description, and the result a tool returns ("Call submit_finding now"). All of
// them get the same names as the tools, or the agent is told a name it lacks at
// the exact moment it must call one. A result is plain data; only its text
// blocks are touched.
function renameResult(result, rename) {
  if (!result || !Array.isArray(result.output)) return result;
  return { ...result, output: result.output.map((o) => (o?.type === "text" && typeof o.text === "string" ? { ...o, text: rename(o.text) } : o)) };
}

// A schema is plain JSON Schema data. Only `description` values are renamed: an
// `enum`/`const` value stays as it is, because the pack compares against it.
function renameSchema(value, rename) {
  if (Array.isArray(value)) return value.map((v) => renameSchema(v, rename));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "description" ? rename(v) : renameSchema(v, rename)]));
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

  // The modules that read code (and get the fetched tree copied in). A run of
  // capture modules only fetches nothing and the members' own tool is left alone.
  const codeMembers = members.filter((p) => p.id === "contracts" || p.id === "review");
  const fetched = new Map(); // url -> report, once the one clone is done
  let queue = Promise.resolve();

  // ONE clone per link for the run, into the root's vendor/ (the run's shared
  // tree), serialized and shared: a second caller of the same link waits for the
  // first and gets its report. The tree is then copied into every code member, so
  // each module's own read tools work on its own paths.
  function ensureFetch(ws, url) {
    if (fetched.has(url)) return Promise.resolve(fetched.get(url));
    // Serialized, and the cache is checked again once this call reaches the head of
    // the queue: a second caller of the same link that was waiting finds the first
    // caller's report instead of cloning. The queue survives a refusal, so one
    // wrong URL cannot poison the run.
    const run = queue.catch(() => {}).then(async () => {
      if (fetched.has(url)) return fetched.get(url);
      const report = await fetchSource(ws, url);
      fetched.set(url, report);
      return report;
    });
    queue = run;
    return run;
  }

  // A small duplicate of the part of a module's fetch that the shared clone skips:
  // that module's two events, its own text, and (for contracts) the solc warm the
  // offline proof needs. The clone, the tree and `source-fetch` stay the run's one.
  async function completeFetch(p, ws, url, report, already) {
    event("fetch_source", { url });
    const where = report?.where;
    if (where) {
      for (const other of codeMembers) {
        try {
          cpSync(path.join(ws, where), path.join(memberDir(ws, other.id), where), { recursive: true, force: true });
        } catch {
          // one module's copy must not fail the fetch
        }
      }
    }
    const solid = (report?.files ?? []).map((f) => f.path ?? f).filter((f) => /\.sol$/i.test(String(f)));
    const warmed = [];
    if (p.id === "contracts") {
      const versions = new Set();
      for (const f of report?.files ?? []) for (const pragma of f.pragmas ?? []) { const v = concreteSolc(pragma); if (v) versions.add(v); }
      for (const v of versions) { const w = await warmSolc(v); warmed.push(`${w.version}${w.ok ? "" : " (warm failed)"}`); }
    }
    let n = 0;
    if (where) {
      try {
        n = [...readdirSync(path.join(ws, where), { recursive: true, withFileTypes: true })].filter((e) => e.isFile()).length;
      } catch {
        n = 0;
      }
    }
    event("fetch_source-done", { url, ok: true, kind: report?.kind, files: n, ...(warmed.length ? { warmed } : {}) });
    const lines = [already ? `Already fetched for this run: ${where ?? url}` : `Fetched ${url} into ${where ?? "(not saved)"}`, ""];
    if (solid.length) lines.push("Solidity files now available:", ...solid.map((f) => `  ${f}`), "");
    lines.push(`Use list_sources to see all ${n} file${n === 1 ? "" : "s"}, then read_source.`);
    if (warmed.length) lines.push(`Compiler versions prepared: ${warmed.join(", ")}.`);
    return { output: [{ type: "text", text: lines.join("\n") }] };
  }

  return {
    id: MULTI,
    title: titles.join(" + "),
    packs: ids,
    // Some module here reads source, so the engine mounts the index layer over
    // the run's shared tree (agent-run.mjs).
    readsCode: ids.some((id) => id === "contracts" || id === "review"),
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
      const out = members.flatMap((p) => {
        const rename = renameFor(ws, p.id);
        // Every tool is wrapped, not only a renamed one: a plain name can still
        // name a shared tool in its description, a parameter or its result.
        return (p.tools?.(memberDir(ws, p.id), viewOf(state, p.id)) ?? []).map((t) => ({
          ...t,
          name: rename(t.name),
          description: rename(t.description),
          ...(t.parameters ? { parameters: renameSchema(t.parameters, rename) } : {}),
          // A fetch brings the tree in once, for the run, and hands every module
          // that reads code its own copy: a scope is read, not re-cloned.
          execute: async (...args) => {
            if (t.name !== "fetch_source" || !codeMembers.length) return renameResult(await t.execute(...args), rename);
            const url = String(args?.[0]?.url ?? "").trim();
            const again = fetched.has(url);
            event("fetch_source", { url });
            let report;
            try {
              report = await ensureFetch(ws, url);
            } catch (err) {
              const why = String(err?.message ?? err);
              event("fetch_source-done", { url, ok: false, error: why.slice(0, 200) });
              return { output: [{ type: "text", text: rename(`Could not fetch ${url}: ${why}`) }], isError: true };
            }
            // The primary caller's own work is done here too, identically.
            return renameResult(await completeFetch(p, ws, url, report, again), rename);
          },
        }));
      });
      // The registry routes a call by name. Two tools with one name would send a
      // call to the wrong module, so say so once rather than mis-route silently.
      const seen = new Set();
      for (const t of out) {
        if (seen.has(t.name)) throw new Error(`two tools of this run are both named "${t.name}"`);
        seen.add(t.name);
      }
      return out;
    },

    // Each module's own first message. The pre-pass values travel as
    // `TS_<ID>__<KEY>`, and this runs on another pack object (the server runs
    // the pre-pass, the worker builds the pack), so each module's own keys come
    // out of `env` here and every other module's key goes. A plain key of
    // another module would otherwise read as its own (`LEADS`); real environment
    // (PATH and the rest) passes through untouched.
    // Text the engine appends outside a module's own prompt (the nav layer): its
    // tool names get the same forms, joined with "or" because it speaks for the
    // whole run.
    // The name one module's tool really has in this run (for tests and callers
    // that hold a pack's own name).
    nameFor(ws, id, name) {
      return renameFor(ws, id)(name);
    },

    renameText(ws, text) {
      const owners = new Map();
      for (const p of members) for (const t of p.tools?.(memberDir(ws, p.id), scratchState()) ?? []) owners.set(t.name, [...(owners.get(t.name) ?? []), p.id]);
      let out = text;
      for (const [name, who] of owners) {
        const forms = who.length > 1 ? who.map((id) => `${name}_${slug(id)}`).join(" or ") : name;
        out = out.replace(new RegExp(`\\b${escape(name)}\\b`, "g"), forms);
      }
      return out;
    },

    kickoff(ws, env = {}) {
      const prefixes = members.map((p) => [p.id, envKey(p.id, "")]);
      const produced = new Set((env[PRODUCED] ?? "").split(",").filter(Boolean));
      const parts = members.map((p) => {
        const own = { ...env };
        delete own[PRODUCED];
        for (const k of produced) delete own[k];
        for (const [k, v] of Object.entries(env)) {
          const owner = prefixes.find(([, prefix]) => k.startsWith(prefix));
          if (!owner || owner[0] !== p.id) continue;
          own[k.slice(owner[1].length)] = v;
        }
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
    // whose pre-pass fails does not stop the others. Its env keys go out under
    // `TS_<ID>__<KEY>` only, never plain: a plain key would reach every module,
    // and web's leads would print under domains. kickoff splits them again.
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
      const env = {};
      const produced = new Set();
      for (const [id, r] of done) {
        for (const [k, v] of Object.entries(r.env ?? {})) {
          env[envKey(id, k)] = v;
          produced.add(k);
        }
      }
      if (produced.size) env[PRODUCED] = [...produced].join(",");
      const byPack = Object.fromEntries(done.map(([id, r]) => [id, r.record ?? null]));
      // Only the module ids: a pre-pass error text can hold a secret.
      const record = { pack: MULTI, packs: ids, byPack, ...(failed.length ? { failed: failed.map(([id]) => id) } : {}) };
      // Contracts keeps each of its pre-pass parts at the top, as a one-module
      // run does, so its own panels still find them.
      for (const k of ["static", "fuzz", "symbolic", "chimera"]) if (byPack.contracts?.[k]) record[k] = byPack.contracts[k];
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
      // A finding with no module is still a finding: it records unproven, as one
      // on a one-module run does when its replay cannot run.
      const loose = (found ?? []).filter((f) => !ids.includes(f?.pack));
      if (loose.length) log(`${loose.length} finding(s) name no module of this run; they are kept unproven`);
      for (const f of loose) out.push({ ...f, pocProved: false });
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
