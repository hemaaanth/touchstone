# Out-of-process attacker sandbox (F1 review R1 / fleet Tier-2)

The isolation boundary for an **untrusted attacker worker** — a Tier-2 abliterated model's
PoC (`docs/fleet-orchestration.md` §2) or F1's `buildAttack` raw-tx author. Built **once**,
shared by both (§8).

## The problem it closes (F1 review finding R1, BLOCKING)

The lab's Anvil is an un-authed cheat RPC. The F1 raw-tx proof constrains the *provider* it
hands the attacker (a read-only proxy), but **not the attacker process**. R1: any process on
**host loopback** can reach the lab directly — port-scan `127.0.0.1`, or `docker port` the
labelled container — call `anvil_setBalance`, and forge a credited drain with no real
vulnerability. The proxy is irrelevant if the attacker never uses it.

The fix R1 names: run the attacker **out-of-process** in its own network namespace with **no
host network** and **no docker socket**, and expose the lab **only** over a brokered IPC /
unix-domain socket. That is exactly this module.

## How it works

```
  HOST side (trusted)                    │  SANDBOX (untrusted worker)
                                         │  own netns: empty loopback, NO host network
  Anvil lab ──┐                          │  own mount ns: /run is tmpfs, NO docker socket
  (cheat RPC) │                          │
              ▼                          │
  broker.mjs  ── AF_UNIX socket ─────────┼──►  attacker.mjs
  read-only   (pathname socket on        │     • 127.0.0.1:PORT  → ENETUNREACH (no route)
  JSON-RPC    the shared filesystem)     │     • /run/docker.sock → absent
  relay                                  │     • broker socket    → reachable (reads only)
```

- **`netns.mjs`** — `enter(argv, {env})` runs the worker under `unshare -rnm` (unprivileged
  user+net+mount namespaces) and mounts a tmpfs over `/run` before exec. Result: the worker
  has an empty network namespace (host `127.0.0.1` is `ENETUNREACH`, and there is no egress
  at all — offline by construction) and no docker socket (`/run/docker.sock` and
  `/var/run/docker.sock` via the `/var/run -> /run` symlink both vanish). `sandboxCapabilities()`
  checks this is genuinely available and returns why if not.
- **`broker.mjs`** — `startBroker()` is an HTTP JSON-RPC relay bound to an **AF_UNIX pathname
  socket** (not a TCP port) in a `0700` dir. A pathname socket crosses the netns boundary
  because it is not IP networking; every TCP route to the lab is gone. It forwards a read-only
  allowlist and rejects `anvil_*`/`evm_*`/`eth_sendTransaction`/… — so even the one sanctioned
  channel cannot forge a drain. (Allowlist adapted from this repo's F1 `startReadOnlyProxy`.)
- **`lab.mjs`** — starts a **real Anvil** (foundry 1.9.0, `touchstone-chain-tools:wave1`) in
  the R1-vulnerable posture (published on host loopback) so the proof shows the sandbox closes
  R1 *even then*.
- **`attacker.mjs`** — the worker as it runs inside the sandbox; probes all four vectors.
- **`proof.mjs`** — the orchestrator and assertions.

## Running the proof

```
node spike/lib/sandbox/proof.mjs      # recorded output: PROOF.txt
```

Baseline (no sandbox) reproduces R1: an in-process attacker reaches the loopback cheat RPC and
drains the victim 10000 ETH → 0. Sandboxed: loopback `ENETUNREACH`, no docker socket, the lab
reachable **only** through the brokered unix socket, and a drain through the broker rejected —
host-side balance confirmed unmutated. Exit 0 iff all seven checks pass.

Tests: `cd spike && node --test test/sandbox-isolation.test.mjs` (boundary tests need
namespaces; the full-proof test also needs the lab image; both skip honestly otherwise).

## Host prerequisites (honest)

- **Linux with unprivileged user namespaces** (`kernel.unprivileged_userns_clone=1`, or the
  distro default) + `unshare` from util-linux ≥ 2.38. No root, no setuid. Verified here on
  util-linux 2.42.4. **macOS/Windows and hardened kernels that disable unprivileged userns are
  not supported** — `sandboxCapabilities()` reports this and the proof exits 2 rather than
  faking a pass. In a container-based runtime the equivalent is a dedicated netns with no CNI
  and no bind-mounted docker socket.
- **The lab image** `touchstone-chain-tools:wave1` for the proof only (the boundary itself
  needs no docker). The sandbox never touches docker — that is the point.

## Production delta (not done here, by scope)

- Point the broker's upstream at **`anvil --ipc`** and **drop the host-loopback publish
  entirely** — defense in depth, removing the R1 vector at the source instead of only fencing
  the attacker away from it. The broker is upstream-agnostic, so only `lab.mjs` changes.
- Add the loopback-reachability probe (here: `attacker.mjs`) as a standing regression test in
  the F1 raw-tx pipeline, run from inside the sandbox on every proof.
- Seccomp/no-new-privs hardening on the worker exec for defense in depth.

## R1 status

**Closed** for the attacker-isolation claim: the in-process host-loopback drain is impossible
from the sandbox, and the only path to the lab is a read-only brokered unix socket. The
production delta above is hardening/wiring, not a hole in the boundary this module proves.
