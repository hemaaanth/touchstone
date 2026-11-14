// What a module needs before it can run, and whether the server has it.
//
// WHY. A module used to be a free choice: pick it and it runs. That was true while
// every module worked from files alone. A module that reads a real chain cannot
// work without an RPC, and letting it run anyway is worse than not running it: the
// audit would report "nothing found" from a scanner that never reached the chain.
// So a pack DECLARES its needs here, and the console greys the module out until
// they are met. The engine refuses the same way, from the same table, so the
// button and the server cannot disagree.
//
// WHAT A NEED IS. One row per input: what it is, which key in the pack's config it
// corresponds to, and a check that says whether it is met right now. A need is
// either "configure in Settings" (an RPC, a key) or "the operator must set this on
// the run" (a chain and a pinned block).
import { forkEnv, rpcState } from "./rpc-store.mjs";
import { FORK_CHAINS } from "./fork.mjs";

// A module's needs, in the order the console lists them. Absent = the module has
// no needs, which is every module today except Contracts when it forks.
//
//   id      stable key the UI can act on
//   label   what the operator reads
//   kind    "settings" (fix it in Settings) | "run" (fix it on the run)
//   met     true when the server already has it
//   detail  why it is not met, or where it is set
export function moduleNeeds(packId) {
  if (packId !== "contracts") return [];
  // Contracts needs nothing to run against files or a lab: those never fork, so
  // they never reach the network. The need appears only when a target asks for a
  // fork, which is why this row is reported per TARGET below rather than here.
  return [];
}

// The needs that apply to a module ON a particular target. This is where a fork
// turns into a requirement: a target with a `fork` cannot run under a module that
// has no RPC for that chain, and cannot run at all without a pinned block.
//
// `target` is a TargetChoice/TargetScope. Returns { ok, needs: [...] }.
export function targetNeeds(target, packId) {
  const needs = [];
  const fork = target?.fork ?? null;
  if (!fork) return { ok: true, needs };
  if (packId !== "contracts") {
    // A fork is a Contracts concept: its replay is the one thing that reads a
    // chain. A module that never forks (Review reads code and nothing else) is
    // unaffected by the pin, so it is READY: refusing it would block a scope for
    // a reason that module cannot act on. The fork simply does not apply to it.
    return { ok: true, needs };
  }
  const chain = String(fork.chain ?? "").toLowerCase();
  const spec = FORK_CHAINS[chain];
  if (!spec) {
    needs.push({
      id: "fork-chain",
      label: "A known chain",
      kind: "run",
      met: false,
      detail: `"${fork.chain ?? ""}" is not a chain this build can fork. Known: ${Object.keys(FORK_CHAINS).join(", ")}.`,
    });
    return { ok: false, needs };
  }
  const block = Number(fork.block);
  needs.push({
    id: "fork-block",
    label: `A pinned block on ${chain}`,
    kind: "run",
    met: Number.isSafeInteger(block) && block > 0,
    detail: Number.isSafeInteger(block) && block > 0
      ? `Pinned at block ${block}. Every replay reads this block, so the proof cannot move under you.`
      : "A fork with no block number is not reproducible: the same test would pass today and fail next month.",
  });
  // The RPC that chain needs. Read from the same store the run reads, so the
  // console and the engine cannot disagree about whether the chain is reachable.
  const row = rpcState().find((r) => r.chain === chain) ?? null;
  const hasUrl = Boolean(forkEnv()[spec.rpcVar]);
  needs.push({
    id: "fork-rpc",
    label: `An RPC for ${chain}`,
    kind: "settings",
    met: hasUrl,
    detail: hasUrl
      ? `${row?.source === "env" ? `From ${row.envName}` : "Saved in Settings"}, ending ${row?.last4 ?? "?"}.`
      : `Add an RPC for ${chain} in Settings, or set ${spec.rpcVar}. Without it the replay cannot reach the chain.`,
  });
  return { ok: needs.every((x) => x.met), needs };
}

// Every target the console offers, with the needs its modules impose. A target is
// runnable when it was runnable before AND every module it names is ready. So a
// forked target with no RPC shows as not runnable, with the reason attached,
// instead of failing at run start.
export function targetsWithNeeds(targets) {
  return targets.map((t) => {
    const packs = t.packs ?? (t.pack ? [t.pack] : []);
    // A target is ready when the module it will EARNESTLY run is ready. A scope
    // that allows both Contracts and Review on a forked target is fine: Review
    // reads the code and never forks, so it needs no RPC. Only the modules that
    // would actually use the chain impose the need. `packs` order puts the
    // scope's own declared module first, so that is the one that decides.
    const results = packs.map((id) => ({ pack: id, ...targetNeeds(t, id) }));
    // Per module, so the console can say WHICH module is blocked. A forked scope
    // that allows both Contracts and Review is runnable overall (Review never reads
    // a chain) while Contracts is not, and "this module is unavailable" must be
    // readable per module or the Modules page cannot be honest.
    const byPack = Object.fromEntries(results.map((r) => [r.pack, r.needs.filter((x) => !x.met)]));
    const usable = results.filter((r) => r.ok);
    // `runnable` is always present on the way out. A caller may pass a target whose
    // runnable was never set (a freshly created scope), and leaving it undefined
    // would render as "unknown" rather than "ready".
    if (usable.length) return { ...t, runnable: t.runnable !== false, needs: [], needsByPack: byPack };
    // Nothing can run: report the needs of the first module, which is the one the
    // operator picked, so the reason matches what they tried to start.
    const needs = (results[0]?.needs ?? []).filter((x) => !x.met);
    return { ...t, runnable: false, needs, needsByPack: byPack };
  });
}
