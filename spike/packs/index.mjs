// Every module pack Touchstone knows. The engine picks one per run from the
// workspace config (`.touchstone.json` field `pack`), so the tool set is fixed
// for the whole run, as pi-durable requires. A run with no `pack` field is a
// Contracts run, so every older workspace keeps working.
import contracts from "./contracts/pack.mjs";
import supplyChain from "./supply-chain/pack.mjs";
import domains from "./domains/pack.mjs";
import surface from "./surface/pack.mjs";
import keys from "./keys/pack.mjs";
import chainWatch from "./chain-watch/pack.mjs";
import web from "./web/pack.mjs";
import aiMcp from "./ai-mcp/pack.mjs";
import infraCloud from "./infra-cloud/pack.mjs";
import review from "./review/pack.mjs";
import phishing from "./phishing/pack.mjs";

// NOTE: source navigation is NOT a selectable pack. It is the default code-reading
// layer every Contracts and Review run mounts on top of its own tools — see
// agent-run.mjs, which imports sourceNavTools / NAV_SYSTEM from source-nav/pack.mjs
// directly. Listing it here would offer a "mode" that maps to no routable target.
export const PACKS = {
  [contracts.id]: contracts, [supplyChain.id]: supplyChain, [domains.id]: domains, [surface.id]: surface,
  [keys.id]: keys, [chainWatch.id]: chainWatch, [web.id]: web,
  [infraCloud.id]: infraCloud,
  [aiMcp.id]: aiMcp,
  [phishing.id]: phishing,
  // Read-only review for operator scopes with no fitting replay oracle.
  [review.id]: review,
};

export function packFor(cfg = {}) {
  const id = cfg.pack ?? "contracts";
  const pack = PACKS[id];
  if (!pack) throw new Error(`Unknown pack "${id}". Known: ${Object.keys(PACKS).join(", ")}`);
  return pack;
}

// The pack fields that say where a module's tools reach. The Modules page builds
// its sentences from them and from nothing else. See packs/README.md.
//   labTarget   "rule-based": the lab assistant is a stand-in, not a model
//   offline     true: no tool reaches a network
//   fetches     ["github", "solc"]: what the host fetches for the run
//   scanNet     "open": a live run's scanners use the open bridge network
//   grants      "github": a live grant names GitHub repos or orgs, not hosts
//   extraProof  "cloud-http": one check also gets an HTTP replay on a private cloud
const REACH_FIELDS = ["labTarget", "offline", "fetches", "scanNet", "grants", "extraProof"];

// What the New run dialog needs to list the modules.
export function packList() {
  return Object.values(PACKS).map((pack) => {
    const { id, title, tier, proof, live } = pack;
    const row = { id, title: title ?? id, tier, proof, live: live === true };
    // Only a pack that sets a field carries it. An absent field stays absent,
    // so the console does not invent a fact for every module.
    for (const k of REACH_FIELDS) if (pack[k] !== undefined) row[k] = pack[k];
    return row;
  });
}
