// Out-of-process attacker sandbox — the isolation boundary itself (F1 review R1,
// docs/fleet-orchestration.md §8). An untrusted attacker worker (a Tier-2 abliterated
// model's PoC, or F1's buildAttack) runs here with:
//   - its OWN network namespace, with NO host network and an empty loopback, so it cannot
//     reach the lab's Anvil on host 127.0.0.1 (the R1 drain vector) nor egress anywhere;
//   - its OWN mount namespace with a tmpfs over /run, so the docker socket
//     (/run/docker.sock, and /var/run -> /run) is ABSENT — it cannot `docker port`/inspect
//     the labelled lab container (the second R1 vector) or drive docker at all.
// The only path to the lab is a brokered AF_UNIX socket handed in by path (see broker.mjs):
// a pathname socket on the shared filesystem crosses the network-namespace boundary because
// it is not IP networking, while every TCP route to host loopback is gone.
//
// Unprivileged: built on `unshare -rn m` (util-linux), which maps the caller to root inside
// a new user+net+mount namespace with no real capabilities on the host. No setuid, no
// docker, no root. Host prerequisites are checked by sandboxCapabilities() and stated in
// this module's README.md.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";

// The command that enters the sandbox. `unshare -rnm`:
//   -r  map current uid/gid to root inside a new USER namespace (unprivileged)
//   -n  new NET namespace   -> empty, only a DOWN loopback; host 127.0.0.1 is ENETUNREACH
//   -m  new MOUNT namespace -> we can hide /run without touching the host
// Inside it we mount a fresh tmpfs over /run (so the docker socket disappears) and then exec
// the worker. The mount failing is fatal: we must not run an attacker that can still see the
// docker socket, so `set -e` aborts rather than silently degrading the boundary.
const ENTER = 'set -e; mount -t tmpfs none /run; exec "$@"';

// Directories whose absence inside the sandbox we assert. /run covers /var/run via symlink.
export const HIDDEN_DOCKER_SOCKETS = ["/run/docker.sock", "/var/run/docker.sock"];

// Is unprivileged user+net+mount namespacing actually available on this host? Returns
// { ok, reason }. Called by the proof and tests so they fail/skip HONESTLY rather than
// pretending a boundary held when the kernel never created one.
export async function sandboxCapabilities() {
  // unshare present?
  const haveUnshare = await which("unshare");
  if (!haveUnshare) return { ok: false, reason: "unshare (util-linux) not on PATH" };
  // Unprivileged user namespaces enabled? (Debian/Arch expose this toggle.)
  for (const [path, want] of [["/proc/sys/kernel/unprivileged_userns_clone", "1"]]) {
    if (existsSync(path)) {
      const v = (await readMaybe(path)).trim();
      if (v && v !== want) return { ok: false, reason: `${path}=${v} (unprivileged userns disabled)` };
    }
  }
  // Prove it end to end: enter the namespace, hide /run, confirm no network + no socket.
  const probe = await enter(["sh", "-c",
    'ip -o addr show 2>/dev/null | wc -l; [ -e /run/docker.sock ] && echo SOCK || echo NOSOCK'],
    { timeoutMs: 8000 });
  if (probe.code !== 0) return { ok: false, reason: `namespace probe failed: ${probe.stderr.trim() || probe.code}` };
  const lines = probe.stdout.trim().split("\n");
  if (lines[0]?.trim() !== "0") return { ok: false, reason: `netns not empty (${lines[0]} interfaces)` };
  if (lines[1]?.trim() !== "NOSOCK") return { ok: false, reason: "docker socket still visible inside sandbox" };
  return { ok: true, reason: "user+net+mount namespaces available; netns empty; docker socket hidden" };
}

// Run a worker command INSIDE the sandbox. argv is the real command (e.g. ["node", script,
// ...]). Everything the worker is allowed to know (broker socket path, and — for the proof —
// the loopback URL it must fail to reach) is passed via `env`; the worker gets no lab URL or
// container name beyond what the caller chooses to hand it.
export function enter(argv, { env, timeoutMs = 60_000, cwd } = {}) {
  return new Promise((resolve) => {
    const full = ["-rnm", "sh", "-c", ENTER, "sandbox", ...argv];
    execFile("unshare", full, { env: env ?? process.env, timeout: timeoutMs, cwd, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        timedOut: Boolean(err?.killed),
      }));
  });
}

async function which(bin) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try { await access(`${dir}/${bin}`); return true; } catch { /* keep looking */ }
  }
  return false;
}

async function readMaybe(path) {
  try { return await readFile(path, "utf8"); } catch { return ""; }
}
