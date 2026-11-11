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

The fix R1 names: run the attacker **out-of-process** with **no host network** and **no docker
socket**, exposing the lab **only** over a brokered IPC / unix-domain socket. That is this module.

## Why bubblewrap, not a hand-rolled mask (the second review's correction)

The first cut ran the worker under `unshare -rnm` and masked the docker socket with a `tmpfs`
over `/run`. An adversarial review broke it two ways **on this host**:

- **Bypass A — reversible mask.** The worker is root in its *own* user namespace with
  `CAP_SYS_ADMIN`, so `umount /run` removes the tmpfs and the host `/run/docker.sock` is back.
- **Bypass B — host procfs leak.** `/proc` was the *host* procfs, so
  `/proc/<otherpid>/root/run/docker.sock` reaches the real host `/run` straight past the mask.

The docker socket is the unauthenticated host engine; reaching it by **any** path is full host
compromise (`docker exec` the lab to forge the drain; `docker run --privileged -v /:/host`).
Masking a socket is not containment — it must **not exist** in the worker's filesystem reality.

Bubblewrap (bwrap 0.13.1, unprivileged, LGPL-2.1+; run as a separate program, not vendored)
gives exactly that. The fixed profile in `jail.mjs`:

- **`--unshare-all --unshare-net`** — own user/mount/pid/ipc/uts/cgroup/net namespaces. The
  netns is empty: the host lab on `127.0.0.1:PORT` is unreachable (`ECONNREFUSED`/`ENETUNREACH`),
  and there is no egress at all — offline by construction.
- **pivot_root into a composed rootfs** — only `--ro-bind /usr` (plus `/bin`→`usr/bin`,
  `/lib(64)`→`usr/lib` symlinks so `node` runs). `/run` is **never created**, so the docker
  socket does not exist on any path; `/home`, the repo, `~/.ssh`, the host `/proc` are absent.
- **`--cap-drop ALL`** — belt-and-suspenders over bwrap's default drop. No `CAP_SYS_ADMIN`, so
  the worker cannot `umount` anything (kills Bypass A). `PR_SET_NO_NEW_PRIVS` is bwrap's default.
- **`--proc /proc` in the new PID ns** — a **fresh** procfs. `pid 1` is `bwrap`, only sandbox
  pids are visible, and `/proc/<pid>/root/...` leads nowhere on the host (kills Bypass B).
- **`--clearenv` + an allowlist** — the worker gets ONLY the env named in `setenv`. The host
  env, with its tokens/keys, is **never** handed to the untrusted child.

```
  HOST side (trusted)                    │  SANDBOX (bwrap: own pid+mount+net ns, pivot_root)
                                         │  netns is empty: NO host network
  Anvil lab ──┐                          │  no /run, no docker.sock; fresh /proc; caps dropped
  (cheat RPC) │                          │
              ▼                          │
  broker.mjs  ── AF_UNIX socket ─────────┼──►  attacker.mjs
  read-only   (pathname socket, bound    │     • 127.0.0.1:PORT  → unreachable (empty netns)
  JSON-RPC    rw into /lab only)         │     • /run/docker.sock → does not exist
  relay                                  │     • /lab/lab.sock     → reachable (reads only)
```

- **`broker.mjs`** — `startBroker()` is an HTTP JSON-RPC relay on an **AF_UNIX pathname socket**
  (not a TCP port) in a `0700` dir, bound read-write into the sandbox at `/lab`. A pathname
  socket crosses the netns boundary because it is not IP networking; every TCP route is gone. It
  forwards a read-only allowlist and rejects `anvil_*`/`evm_*`/`eth_sendTransaction`/… — so even
  the one sanctioned channel cannot forge a drain. (Allowlist adapted from this repo's F1
  `startReadOnlyProxy`.)
- **`lab.mjs`** — starts a **real Anvil** (foundry 1.9.0, `touchstone-chain-tools:wave1`) in the
  R1-vulnerable posture (published on host loopback) so the proof shows the sandbox closes R1
  *even then*.
- **`probe.mjs`** — the containment self-check run FROM INSIDE the sandbox. Every check is a
  **negative assertion** that must fail to reach the host: `umount` blocked, docker socket absent
  on every path, docker engine unreachable over its socket, fresh procfs (pid1 ≠ host init, no
  `/proc/<pid>/root` escape), host filesystem invisible, repo/judge unwritable, no non-loopback
  NICs. This replaces the first cut's blind `stat(masked path)` that the review caught.
- **`attacker.mjs`** — the worker as it runs inside the sandbox: emits the containment report
  plus the three lab-reach probes (loopback drain, broker read, broker drain).
- **`proof.mjs`** — the orchestrator and assertions.

## Running the proof

```
node spike/lib/sandbox/proof.mjs      # recorded output: PROOF.txt
```

Baseline (no sandbox) reproduces R1: an in-process attacker reaches the loopback cheat RPC and
drains the victim to 0. Sandboxed: the containment report shows every host-reaching vector dead,
the loopback drain is unreachable, the lab is reachable **only** through the brokered unix
socket, and a drain through the broker is rejected — host-side balance confirmed unmutated. Exit
0 iff every check passes; exit 2 (honest skip) if the host lacks bwrap or the lab image.

Tests: `cd spike && node --test test/sandbox-isolation.test.mjs` (boundary tests need bwrap; the
full-proof test also needs the lab image; both skip honestly otherwise).

## Host prerequisites (honest)

- **Linux with unprivileged user namespaces** + **bubblewrap** (`bwrap`) on PATH. No root, no
  setuid-root bwrap required (bwrap uses unprivileged userns here). Verified on bwrap 0.13.1,
  node v26, kernel 7.2. **macOS/Windows and hardened kernels that disable unprivileged userns
  are not supported** — `sandboxCapabilities()` RUNS the probe inside the sandbox and only
  returns ok when containment genuinely holds; otherwise the proof exits 2 rather than faking a
  pass. In a container-based runtime the equivalent is a dedicated netns with no CNI and no
  bind-mounted docker socket.
- **The lab image** `touchstone-chain-tools:wave1` for the proof only (the boundary itself needs
  no docker). The sandbox never touches docker — that is the point.

## Production delta (not done here, by scope)

- Point the broker's upstream at **`anvil --ipc`** and **drop the host-loopback publish
  entirely** — defense in depth, removing the R1 vector at the source instead of only fencing the
  attacker away from it. The broker is upstream-agnostic, so only `lab.mjs` changes.
- Wire `probe.mjs`'s loopback-reachability check into the F1 raw-tx pipeline as a standing
  regression test, run from inside the sandbox on every proof.
- A seccomp profile on the worker exec for additional syscall-surface reduction (bwrap already
  applies `no_new_privs` + dropped caps).

## R1 status

**Closed** for the attacker-isolation claim. From inside the sandbox the attacker cannot reach
the docker socket, the host procfs, the host filesystem or the host network **by any path**
(both review bypasses verified dead on this host), the in-process host-loopback drain is
impossible, and the only path to the lab is a read-only brokered unix socket. The production
delta above is hardening/wiring, not a hole in the boundary this module proves.
