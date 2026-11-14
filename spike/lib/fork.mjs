// Forking a real chain, for a replay that must land on real deployed state.
//
// WHY. Every proof in this product used to run with `--network none` and no fork,
// so the auditor's PoC could only ever attack a contract it deployed itself from
// source. That is a fine model for "is this code wrong", and the wrong model for
// "would this attack have worked on the real protocol", because the real protocol
// lives in live state: pools with real reserves, oracles with real prices, LP
// positions held by real users. Measured 2026-11-14: 901 of 901 incident
// reproductions in the DeFiHackLabs corpus are fork-based, so an offline-only
// proof cannot replay a single one of them.
//
// WHAT CHANGES, AND WHAT DOES NOT. A run gets a fork only when the operator points
// it at one, by putting `fork` in the workspace config. Without that field every
// command is exactly what it was: `--network none`, no `--fork-url`, no endpoint.
// A fork adds two things and nothing else: the container joins the network (it
// must reach the RPC), and forge is given `--fork-url` plus the pinned block. The
// provider key is passed as an environment variable and never written into the
// workspace, so it cannot land in a replay bundle or a finding.
//
// PINNING. A fork without a block is not reproducible: the same PoC passes today
// and fails next month, and a "proof" that changes under you is not a proof. So a
// block number is REQUIRED. `pinFork` refuses a fork that names no block.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A chain the fork may target. `id` is the EVM chain id; `rpcVar` is the
// environment variable the URL arrives in, so the key is never a file the agent
// can read. The name is what the foundry.toml endpoint and a PoC's
// createSelectFork("mainnet", …) use.
export const FORK_CHAINS = {
  mainnet: { id: 1, rpcVar: "TOUCHSTONE_FORK_RPC_1" },
  bsc: { id: 56, rpcVar: "TOUCHSTONE_FORK_RPC_56" },
  polygon: { id: 137, rpcVar: "TOUCHSTONE_FORK_RPC_137" },
  optimism: { id: 10, rpcVar: "TOUCHSTONE_FORK_RPC_10" },
  arbitrum: { id: 42161, rpcVar: "TOUCHSTONE_FORK_RPC_42161" },
  base: { id: 8453, rpcVar: "TOUCHSTONE_FORK_RPC_8453" },
  avalanche: { id: 43114, rpcVar: "TOUCHSTONE_FORK_RPC_43114" },
  gnosis: { id: 100, rpcVar: "TOUCHSTONE_FORK_RPC_100" },
};

// The RPC URL is a credential. It is checked by shape only, never logged, and it
// is rejected if it carries a username or password: those would have to survive
// into a shell argument, and a URL with userinfo in it is a secret in a place we
// cannot redact. A provider that needs auth uses a key in the path or a query.
export function validRpcUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? "").trim()); } catch { return null; }
  if (u.protocol !== "https:") return null;      // no plain http: the key would travel in clear
  if (u.username || u.password) return null;      // userinfo cannot be redacted from every sink
  if (!u.hostname) return null;
  return u.href;
}

// Normalize and check a fork request. Returns { chain, chainId, block, rpcVar } or
// throws with a message the operator can act on. `block` is required: see PINNING.
export function pinFork({ chain, block, addresses } = {}) {
  const name = String(chain ?? "").trim().toLowerCase();
  const spec = FORK_CHAINS[name];
  if (!spec) {
    throw new Error(`Unknown fork chain "${chain ?? ""}". Known: ${Object.keys(FORK_CHAINS).join(", ")}.`);
  }
  const n = Number(block);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error("A fork needs a block number. A fork with no pinned block is not reproducible: the same test would pass today and fail later.");
  }
  // The contracts the deployed oracle may treat as victims. Optional: a pin with no
  // addresses can still replay, it just has no on-chain victim to credit.
  const list = Array.isArray(addresses) ? [...new Set(addresses.map((a) => String(a ?? "").trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))] : [];
  return { chain: name, chainId: spec.id, block: n, rpcVar: spec.rpcVar, ...(list.length ? { addresses: list } : {}) };
}

// Does this run fork? The workspace config carries `fork` only when the operator
// asked for one, so an absent field means every command stays exactly as it was.
export function forkOf(cfg) {
  return cfg && cfg.fork ? pinFork(cfg.fork) : null;
}

// The forge flags a fork adds. Empty string when the run does not fork, so a
// caller can concatenate unconditionally and the offline command is byte-identical.
export function forkFlags(fork) {
  if (!fork) return "";
  return `--fork-url "$${fork.rpcVar}" --fork-block-number ${fork.block} `;
}

// The `docker run` arguments a fork adds: the network (the container must reach the
// RPC) and the URL in the environment. `--network host` rather than the default
// bridge because a provider on the operator's own network (a LAN node, a sidecar)
// must work too; the sandbox is still a throwaway container with no mounts beyond
// the workspace.
export function forkArgs(fork, env = process.env) {
  if (!fork) return ["--network", "none"];
  const url = env[fork.rpcVar];
  if (!url) {
    throw new Error(`No RPC for ${fork.chain}: ${fork.rpcVar} is not set. Add the chain RPC in Settings, or set ${fork.rpcVar} for this process.`);
  }
  const clean = validRpcUrl(url);
  if (!clean) throw new Error(`The RPC for ${fork.chain} is not a usable https URL (no credentials in the URL).`);
  return ["--network", "host", "-e", `${fork.rpcVar}=${clean}`];
}

// The foundry.toml `[rpc_endpoints]` block a fork needs, so an agent's own
// `vm.createSelectFork("mainnet", N)` resolves the same chain the gate forks. Only
// the forked chain is written: a second chain would be a second credential.
export function forkEndpoints(fork) {
  if (!fork) return "";
  return `[rpc_endpoints]\n${fork.chain} = "\${${fork.rpcVar}}"\n`;
}

// Append the endpoint block to a foundry.toml's text, once, in the profile. An
// existing [rpc_endpoints] is replaced rather than duplicated: forge refuses a
// duplicate table, and a stale one would point at a chain nobody selected.
export function withForkEndpoints(toml, fork) {
  if (!fork) return toml;
  const text = String(toml ?? "");
  const body = text.replace(/\n?\[rpc_endpoints\][\s\S]*?(?=\n\[|$)/, "").replace(/\s+$/, "");
  return `${body}\n\n${forkEndpoints(fork)}`;
}

// Apply a fork to a workspace that is already built: write the pin into the run's
// config (so every later step, in another process, agrees) and add the endpoint
// block to foundry.toml (so the agent's own createSelectFork resolves the same
// chain the gate forks). Returns the fork it applied, or null. A target with no
// `fork` is untouched, so every existing target keeps the offline behaviour.
export function applyForkToWorkspace(ws, target, { readCfg, writeCfg } = {}) {
  const requested = target?.fork;
  if (!requested) return null;
  // The addresses the forked replay may treat as victims (the deployed oracle,
  // lib/oracle-deployed.mjs). Written into the run's config so the gate reads them
  // from the record, never from an argument a caller could forget.
  const fork = pinFork(requested);
  const tomlPath = join(ws, "foundry.toml");
  let toml = "";
  try { toml = readFileSync(tomlPath, "utf8"); } catch { toml = "[profile.default]\nsrc = \"src\"\ntest = \"test\"\nout = \"out\"\nlibs = [\"lib\", \"vendor\"]\n"; }
  writeFileSync(tomlPath, withForkEndpoints(toml, fork));
  const addrs = Array.isArray(requested.addresses) ? requested.addresses.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(String(a ?? "").trim())) : [];
  if (writeCfg) writeCfg({
    ...(readCfg?.() ?? {}),
    fork: { chain: fork.chain, block: fork.block },
    ...(addrs.length ? { forkTargets: { addresses: addrs.map((a) => String(a).toLowerCase()), label: requested.label ?? null } } : {}),
  });
  return fork;
}
