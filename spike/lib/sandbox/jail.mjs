// Out-of-process attacker sandbox — the isolation boundary (F1 review R1,
// docs/fleet-orchestration.md §8). An untrusted attacker worker (a Tier-2 abliterated
// model's PoC, or F1's buildAttack) runs here with no path to the host, and the lab reachable
// ONLY through a brokered unix socket.
//
// WHY bubblewrap, not a hand-rolled `unshare -rnm` mask. The first cut of this module masked
// the docker socket with a tmpfs over /run. An adversarial review broke it two ways on the
// same host: (A) the worker is root in its OWN userns with CAP_SYS_ADMIN, so `umount /run`
// removes the mask and the host /run/docker.sock is back; (B) /proc was the HOST procfs, so
// `/proc/<otherpid>/root/run/docker.sock` reaches the real host /run straight past the mask.
// The docker socket is the unauthenticated host engine — reaching it by ANY path is full host
// compromise (docker exec the lab to forge the drain; docker run --privileged -v /:/host).
// Masking a socket is not containment; it must NOT EXIST in the worker's filesystem reality,
// with caps dropped and a fresh procfs. bubblewrap (unprivileged, LGPL-2.1+; run as a separate
// program, not vendored) does exactly that: pivot_root into a rootfs composed only of what we
// bind, a fresh /proc in a new PID namespace, all capabilities dropped, PR_SET_NO_NEW_PRIVS.
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// The fixed sandbox profile. --unshare-all already includes net/pid/ipc/uts/cgroup/user; we
// name --unshare-net too for clarity. --cap-drop ALL is belt-and-suspenders over bwrap's
// default drop (kills the `umount` bypass). --proc in the new PID ns is a FRESH procfs (kills
// the host-procfs bypass + the host process-table read). /run is never created, so the docker
// socket does not exist. Only /usr is bound (read-only; no secrets, no socket); /home, the
// repo, ~/.ssh and the host /proc are simply absent.
function baseArgs() {
  return [
    "--unshare-all", "--unshare-net", "--new-session", "--die-with-parent", "--cap-drop", "ALL",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--clearenv", "--setenv", "PATH", "/usr/bin",
  ];
}

// Run `argv` inside the sandbox. The worker gets ONLY the env in `setenv` (an allowlist — the
// host env, with its tokens/keys, is NEVER handed to the untrusted child). `roBind`/`bind` are
// [hostPath, sandboxPath] pairs: read-only for code, read-write only for the one broker-socket
// directory the worker must reach.
export function enter(argv, { setenv = {}, roBind = [], bind = [], timeoutMs = 60_000 } = {}) {
  const args = baseArgs();
  for (const [k, v] of Object.entries(setenv)) args.push("--setenv", k, String(v));
  for (const [h, s] of roBind) args.push("--ro-bind", h, s);
  for (const [h, s] of bind) args.push("--bind", h, s);
  args.push("--", ...argv);
  return new Promise((resolve) => {
    execFile("bwrap", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut: Boolean(err?.killed),
      }));
  });
}

// Is a real containment boundary available on this host? This does NOT stat a masked path
// (the bug the review caught); it RUNS a probe inside the sandbox and only returns ok when the
// docker engine is unreachable, the host filesystem is invisible, /proc is fresh, and the net
// namespace is empty. Returns { ok, reason } so the proof/tests fail or skip honestly.
export async function sandboxCapabilities() {
  if (!(await onPath("bwrap"))) return { ok: false, reason: "bubblewrap (bwrap) not on PATH" };
  if (!(await onPath("node"))) return { ok: false, reason: "node not on PATH" };
  const probe = await enter(["node", join("/app", "probe.mjs")], {
    roBind: [[join(HERE, "probe.mjs"), "/app/probe.mjs"]], timeoutMs: 15_000,
  });
  if (!probe.stdout.trim()) return { ok: false, reason: `sandbox probe produced no output: ${probe.stderr.trim() || probe.code}` };
  let r; try { r = JSON.parse(probe.stdout.trim()); } catch { return { ok: false, reason: `probe output unparseable: ${probe.stdout.slice(0, 120)}` }; }
  if (!r.contained) return { ok: false, reason: `containment failed: ${JSON.stringify(r.failures)}` };
  return { ok: true, reason: "bwrap containment verified: no docker socket, engine unreachable, fresh /proc, host fs invisible, empty netns" };
}

async function onPath(bin) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try { await access(`${dir}/${bin}`); return true; } catch { /* keep looking */ }
  }
  return false;
}
