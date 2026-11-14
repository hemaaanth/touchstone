// Chain RPC endpoints the operator configures in Settings.
//
// WHY THIS IS SETTINGS AND NOT A SCOPE FIELD. A replay that lands on real
// deployed state needs one RPC per chain, and that URL is a credential: a
// provider key in the path or the query. Scopes are per-target and get copied into
// run records, findings and replay bundles, so a key stored on a scope would follow
// the finding out. Settings is the one place this app already keeps credentials
// (the provider keys and the Daytona key live in data/providers.json, mode 0600,
// gitignored). So an RPC is stored there, under its own key, and reaches a run as
// an environment variable that never touches the workspace.
//
// WHAT A RUN SEES. `forkEnv()` returns { TOUCHSTONE_FORK_RPC_<chainId>: url } for
// the chains the operator configured. lib/fork.mjs reads exactly those names, so a
// fork either has its URL or fails loudly; it can never silently fork the wrong
// chain.
import { readConfig, writeConfig } from "./providers.mjs";
import { FORK_CHAINS, validRpcUrl } from "./fork.mjs";

// The shape a Settings screen reads. A URL never leaves the server: the screen gets
// the chain, whether it is set, and the last 4 characters, the same rule the
// provider keys follow.
export function rpcState(cfg = readConfig()) {
  const saved = cfg.rpc ?? {};
  return Object.entries(FORK_CHAINS).map(([chain, spec]) => {
    const entry = saved[chain] ?? null;
    const fromEnv = process.env[spec.rpcVar] ?? null;
    const url = entry?.url ?? fromEnv ?? null;
    const source = entry?.url ? "settings" : fromEnv ? "env" : null;
    return {
      chain,
      chainId: spec.id,
      envName: spec.rpcVar,
      set: Boolean(url),
      source,
      // Only the tail. A provider key is usually the last path segment or a query
      // value, so 4 characters is enough for an operator to recognise which key it
      // is and useless to anyone else.
      last4: url ? url.slice(-4) : null,
      saved: Boolean(entry?.url),
    };
  });
}

// Save one chain's RPC. An empty url removes it. Throws on a URL that cannot be
// stored: plain http (the key would cross the network in clear) or a URL carrying
// a username and password (which every log sink would have to redact).
export function setRpc({ chain, url } = {}) {
  const name = String(chain ?? "").trim().toLowerCase();
  if (!FORK_CHAINS[name]) throw new Error(`Unknown chain "${chain ?? ""}". Known: ${Object.keys(FORK_CHAINS).join(", ")}.`);
  const cfg = readConfig();
  const rpc = { ...(cfg.rpc ?? {}) };
  const text = String(url ?? "").trim();
  if (!text) {
    delete rpc[name];
  } else {
    const clean = validRpcUrl(text);
    if (!clean) throw new Error("Use an https RPC URL with no username or password in it.");
    rpc[name] = { url: clean, savedAt: new Date().toISOString() };
  }
  writeConfig({ ...cfg, rpc });
  return rpcState({ ...cfg, rpc });
}

// The environment a forked run needs: one variable per configured chain, named
// exactly what lib/fork.mjs looks for. Both a saved value and a server env value
// are offered; the saved one wins, because that is the one the operator just set in
// the app. Only configured chains appear, so an unset chain fails loudly rather
// than inheriting another chain's URL.
export function forkEnv(cfg = readConfig()) {
  const saved = cfg.rpc ?? {};
  const out = {};
  for (const [chain, spec] of Object.entries(FORK_CHAINS)) {
    const url = saved[chain]?.url ?? process.env[spec.rpcVar] ?? null;
    if (url) out[spec.rpcVar] = url;
  }
  return out;
}
