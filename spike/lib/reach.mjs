// The reach gate — the one place a run is allowed (or refused) to touch a live
// network target, and the one place its egress is confined to the granted hosts.
//
// WHY THIS EXISTS. Every offline lab runs with no network. A live-reach target
// touches a REAL host, so two things must hold before a single byte leaves:
//
//   1. DEFAULT-DENY by kind. Only the offline kinds (lab, local-source, brief,
//      scope) may run with no host. EVERY other kind — including a kind we do not
//      recognize — must name its host(s) AND carry a grant. The SAFE set is the
//      explicit allow-list here, not the live set, so a new or unknown kind is
//      refused by default, never waved through by accident.
//   2. CONFINEMENT. When a live run is allowed, a scope proxy is started here
//      whose allow-list is exactly this target's own hosts.
//      The proxy's URL and allow-list ride into the run, so the module's network
//      seam (the http-proof request tool, the browser seam) reaches the granted
//      host and nothing else. The grant pre-flight (requireGrant) REFUSES; the
//      running proxy ENFORCES. One is a pre-flight; the other is confinement.
//
// THE SEAM. A module never calls this. The platform calls openReach in the run
// launch (app/server/runs.mjs createRun) and hands the module a confined handle.
// Swapping a module's direct network for this gated one happens here, behind the
// seam, with no change to any module (WAVE2.md SEAM rule).
import { requireGrant, normalizeHost, getGrant, grantActive, hostCovers } from "./grant-store.mjs";
import { getUserScope } from "./scopes-store.mjs";
import { startScopeProxy } from "./scope-proxy.mjs";
import { confineReach } from "./reach-confine.mjs";

// The kinds that run with no network. Anything NOT in this set is treated as a
// live network kind: it must declare a host and carry a grant. Keeping the SAFE
// set explicit (not the live set) is the default-deny rule: a kind we have not
// listed here is denied, not reached.
export const NON_NETWORK_KINDS = new Set(["lab", "local-source", "brief", "scope"]);

export function isNetworkKind(kind) {
  return !NON_NETWORK_KINDS.has(String(kind || ""));
}

// Every live host a target would touch, read from any of the field names a
// target shape may carry. We read many names on purpose: a live kind that names
// its host as `url`, `domain`, `baseUrl`, `origin`, a `hosts` array, a single
// `host`, or a `reach.scope`/`reach.hosts` list must NOT slip the gate because it
// used a name we did not check. Each value is reduced to a bare hostname with the
// grant store's own normalizer, so the host the gate checks is the host the proxy
// compares on. Anything unusable is dropped. Deduplicated, first-seen order.
export function reachHosts(target) {
  if (!target || typeof target !== "object") return [];
  const out = [];
  const push = (v) => {
    const h = normalizeHost(v);
    if (h && !out.includes(h)) out.push(h);
  };
  const scan = (v) => {
    if (!v) return;
    if (Array.isArray(v)) {
      for (const x of v) scan(x);
    } else if (typeof v === "string") {
      push(v);
    }
    // any other shape carries no host we can trust; ignore it
  };
  scan(target.hosts);
  scan(target.host);
  scan(target.url);
  scan(target.domain);
  scan(target.baseUrl);
  scan(target.origin);
  scan(target.reach && target.reach.scope);
  scan(target.reach && target.reach.hosts);
  return out;
}

// Does this scope's own grant allow private and loopback addresses? Both the
// scope's saved permission and the grant it names must say so. A grant of
// another scope does not count, and a target with no saved permission gets no.
export function allowsPrivate(target, { now = Date.now() } = {}) {
  const p = target?.permission;
  if (p?.allowPrivate !== true || typeof p.grantId !== "string") return false;
  const grant = getGrant(p.grantId);
  return Boolean(grant) && grantActive(grant, now) && grant.allowPrivate === true;
}

// The gate decision, with no network I/O. Returns { hosts, networkKind, grants },
// or throws a clear refusal. Pure, so the default-deny rule is easy to test on
// its own. `grants` is the grants this run uses (empty for an offline run).
//
// WHICH GRANT. A live scope the operator saved is bound to its OWN grant: the
// one its permission tick wrote (scope.permission.grantId). Only that grant
// counts. A grant of another scope that covers the same host does not let this
// scope run, and does not add its hosts or its private-address opt-in to this
// run. A saved live scope with no permission is refused. A target that is not a
// saved scope (a direct call with a host list) may use any active grant that
// covers its hosts.
export function enforceReach(target, { now = Date.now(), grantIds } = {}) {
  const hosts = reachHosts(target);
  const networkKind = isNetworkKind(target && target.kind);
  if (networkKind && !hosts.length) {
    throw new Error(
      `Refused: target kind "${target && target.kind}" reaches the network but names no host. ` +
        `A live-reach target must declare the host(s) it will touch, so a grant and the scope gate can confine it. ` +
        `Only ${[...NON_NETWORK_KINDS].join(", ")} may run with no host.`,
    );
  }
  if (!hosts.length) return { hosts, networkKind, grants: [] };
  const bound = target.permission && typeof target.permission === "object";
  // The grants this run may use. null means any grant in the store.
  let pool = bound ? [getGrant(target.permission.grantId)] : null;
  // A resumed run may use only its original active grants. A replacement grant
  // cannot widen the scope or revive a run after its first grant was revoked.
  if (grantIds != null) pool = (pool ?? grantIds.map(getGrant)).filter((g) => g && grantIds.includes(g.id));
  // A live scope SAVED in the scope store must carry its own permission. One
  // without it (an old or hand-edited scope file) is refused, never matched to
  // another scope's grant. A direct call with a host list (no saved scope)
  // keeps the old rule below. A resumed run (grantIds) keeps only its own
  // saved grants above.
  if (pool == null && target.kind === "live" && getUserScope(target.id)) {
    throw new Error("Refused: this live scope has no saved permission, so no grant counts for it. Add the scope again and tick the permission box.");
  }
  if (pool == null) return { hosts, networkKind, grants: requireGrant(hosts, now) };
  const grants = hosts.map((host) => {
    const grant = pool.find((g) => grantActive(g, now) && g.hosts.some((h) => hostCovers(h, host)));
    if (grant) return grant;
    if (grantIds != null) throw new Error(`Refused: the saved grant for ${host} is missing or expired. Start a new run with a current grant.`);
    throw new Error(`Refused: this scope's own grant does not cover ${host}. The grant was removed, has expired, or does not name that host. A grant of another scope does not count. Add the scope again to confirm permission.`);
  }).filter((g, i, all) => all.findIndex((x) => x.id === g.id) === i);
  return { hosts, networkKind, grants };
}

// Open a run's reach. Enforces the gate; for a live run it starts a confinement
// boundary (lib/reach-confine.mjs) whose one egress is a scope proxy confined to
// the granted hosts, and returns that handle. For an offline run it returns an
// inert handle — so the lab path is unchanged and starts nothing. Always call
// stop() on teardown.
//
// Two dispatch modes:
//   "confine" (what a live run uses) — the run's tools execute in a container on
//     a network with no route off it. Its ONLY path out is the gate, so a tool
//     that ignores the proxy still cannot leave. The env carries the gate under
//     TOUCHSTONE_SCOPE_PROXY and its in-network URL, because the run's tools
//     never run on the host.
//   "proxy" (the default; what unit tests use) — a host-local forward proxy. A
//     cooperating client on this machine routes through it.
//
// We deliberately do NOT set the process-wide HTTP_PROXY: that would also
// capture the agent's own model-inference calls, which go to the provider (an
// un-granted host) and the gate would wrongly block them. The gate confines
// TARGET-bound traffic, not the agent's thinking.
export async function openReach(target, { now = Date.now(), mode = "proxy", proxyHost = "127.0.0.1", grantIds } = {}) {
  const { hosts, networkKind, grants } = enforceReach(target, { now, grantIds });
  if (!hosts.length) {
    return {
      live: false,
      networkKind,
      hosts: [],
      allowedHosts: [],
      env: {},
      proxy: null,
      confine: null,
      log: null,
      stop: async () => {},
    };
  }
  // The allow-list is the target's own hosts, each one covered by a grant
  // above. It is never the grant's host list: a grant that also names other
  // hosts does not widen this run.
  const allow = hosts;
  // A grant that opted into private space (the operator's own LAN, or a test's
  // 127.0.0.1) lets the proxy reach it; a public-host grant never does. Only
  // the grants this run uses count — the allow-list still confines WHICH hosts.
  const allowPrivate = grants.some((g) => g.allowPrivate === true);
  if (mode === "confine") {
    const confine = await confineReach({ allowedHosts: allow, allowPrivate });
    return {
      live: true,
      networkKind,
      hosts,
      allowedHosts: allow,
      // The gate's URL as the RUN's tools see it: an alias on their own network.
      env: { TOUCHSTONE_SCOPE_PROXY: confine.gateUrl, TOUCHSTONE_SCOPE_ALLOW: allow.join(",") },
      proxy: null,
      confine,
      log: null,
      stop: async () => {
        try {
          await confine.stop();
        } catch {
          // already closed
        }
      },
    };
  }
  const proxy = await startScopeProxy({ allowedHosts: allow, host: proxyHost, allowPrivate });
  const env = {
    TOUCHSTONE_SCOPE_PROXY: proxy.url,
    TOUCHSTONE_SCOPE_ALLOW: allow.join(","),
  };
  return {
    live: true,
    networkKind,
    hosts,
    allowedHosts: allow,
    env,
    proxy,
    confine: null,
    log: proxy.log,
    stop: async () => {
      try {
        await proxy.stop();
      } catch {
        // already closed
      }
    },
  };
}
