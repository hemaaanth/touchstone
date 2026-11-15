// A shell-session proof for the machine-layer packs (host, crypto, forensics,
// binary).
//
// The web pack proves a finding by replaying an HTTP script against a fresh lab.
// These packs need the same thing for a shell: replay the finding's command
// script against a fresh target and let an independent oracle read what the
// replay printed.
//
// The anti-forgery rule is STRONGER than the web lab's fixed bugs: every target
// instance gets a NEW random flag (`FLAG{...}`, generated here, never shown to
// the agent), the lab plants it behind the bug, and the oracle compares what the
// replay printed against that instance's flag. A script that echoes a flag pasted
// from the live session cannot pass; only extraction logic survives. This is why
// the oracle takes `{ flag }` and why callers must never put the flag in a prompt.
//
// Layout per target:
//   touchstone-attacker-net-<tag>   one --internal network, no egress
//   touchstone-target-<tag>         the vulnerable container (lab)
//   the script runs in a throwaway container from the pack's toolset image, on
//   that same network, with the run's workspace (or a replay scratch copy)
//   mounted at /work
//
// The transcript is the attacker container's own combined stdout/stderr, framed
// with markers by a fixed wrapper. The oracle reads the framed text, never the
// script's claim about what it did.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLabNetwork, removeLabNetwork } from "./lab-net.mjs";

function docker(args, { timeoutMs = 30_000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolveDocker) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer }, (err, stdout, stderr) => {
      resolveDocker({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        timedOut: Boolean(err?.killed),
      });
    });
  });
}

// Same rule as proof-http: a missing image must fail loudly with the build
// command, never fall through to a registry pull.
export async function requireImage(image, buildArg) {
  const r = await docker(["image", "inspect", image]);
  if (r.code !== 0) {
    throw new Error(`lab image ${image} is not built. This pack cannot run without it. Build it with: npm run build:labs -- ${buildArg}  (that is: bash scripts/build-labs.sh ${buildArg})`);
  }
}

export const SCRIPT_MARK = "__TS_SCRIPT__";
export const RUN_MARK = "__TS_RUN__";
export const EXIT_MARK = "__TS_EXIT__:";

export function newFlag() {
  return `FLAG{${randomBytes(12).toString("hex")}}`;
}

// Start one target instance. Resolves with the handle; the caller's `onStart`
// receives the names as soon as they exist, so a killed prepass can still tear a
// half-started target down by name.
//   image           the vulnerable lab image (required)
//   env             extra `-e` pairs. TOUCHSTONE_FLAG is always set.
//   readyFile       file the lab creates once it is serving (default /lab/ready)
//   caps            keep the default capability set and allow setuid. A lab that
//                   plants an SUID or cron bug needs this: --security-opt
//                   no-new-privileges would block the SUID escalation itself.
//   flag            the instance flag (default: a new one). A pack that must plant
//                   the flag before the container starts generates it itself.
//   mount           host dir mounted at /work in the TARGET (a lab that builds its
//                   artifacts there). The same dir is mounted in the script's
//                   container.
//   onStart(handle) called with the partial handle before Docker creates anything
export async function startTarget({ image, env = {}, readyFile = "/lab/ready", readyTimeoutMs = 90_000, caps = false, flag = newFlag(), mount = null, onStart }) {
  const tag = randomBytes(4).toString("hex");
  const net = `touchstone-attacker-net-${tag}`;
  const targetName = `touchstone-target-${tag}`;
  onStart?.({ net, targetName });
  const cleanup = () => stopTarget({ net, targetName });

  const created = await createLabNetwork(net, ["--internal"], { docker });
  if (created.code !== 0) {
    await cleanup();
    throw new Error(`startTarget: network create failed: ${created.stderr.trim().slice(0, 500)}`);
  }
  const args = [
    "run", "-d", "--rm", "--pull=never", "--name", targetName,
    "--network", net, "--network-alias", "target",
    ...(caps ? [] : ["--cap-drop", "ALL", "--security-opt", "no-new-privileges"]),
    "--pids-limit", "256", "--memory", "512m",
    "-e", `TOUCHSTONE_FLAG=${flag}`,
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...(mount ? ["-v", `${mount}:/work`] : []),
    image,
  ];
  const run = await docker(args);
  if (run.code !== 0) {
    await cleanup();
    throw new Error(`startTarget: target run failed: ${run.stderr.trim().slice(0, 500)}`);
  }
  const handle = { net, targetName, image, flag, readyFile };
  try {
    await waitReady(handle, readyTimeoutMs);
  } catch (err) {
    await cleanup();
    throw err;
  }
  return handle;
}

// Ready when the lab says so from inside. The probe runs through `docker exec`,
// so it never creates a container or touches the network.
async function waitReady(handle, timeoutMs, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await docker(["exec", handle.targetName, "sh", "-c", `test -f ${handle.readyFile}`], { timeoutMs: 10_000 });
    if (r.code === 0) return;
    if (Date.now() >= deadline) throw new Error(`startTarget: ${handle.targetName} was not ready (${handle.readyFile}) within ${timeoutMs}ms`);
    await new Promise((r2) => setTimeout(r2, intervalMs));
  }
}

export async function stopTarget(handle) {
  if (!handle) return;
  if (handle.targetName) await docker(["rm", "-f", handle.targetName], { timeoutMs: 20_000 });
  if (handle.net) {
    // Remove leftovers first: a target's own child containers can survive it.
    const attached = await docker(["network", "inspect", "--format", "{{json .Containers}}", handle.net]);
    if (attached.code === 0) {
      try {
        for (const id of Object.keys(JSON.parse(attached.stdout) ?? {})) await docker(["rm", "-f", id], { timeoutMs: 20_000 });
      } catch { /* nothing attached */ }
    }
    await removeLabNetwork(handle.net, { docker });
  }
}

function wrapper() {
  return [
    `echo ${SCRIPT_MARK}`,
    "cat /run/script.sh",
    `echo ${RUN_MARK}`,
    "sh /run/script.sh 2>&1",
    "code=$?",
    `echo "${EXIT_MARK}$code"`,
    "exit 0",
  ].join("\n");
}

// One script entry, split out of the framed output the oracle reads.
export function parseRun(stdout) {
  const text = String(stdout ?? "");
  const s = text.indexOf(`${SCRIPT_MARK}\n`);
  const r = text.indexOf(`${RUN_MARK}\n`);
  const at = text.indexOf(EXIT_MARK, r === -1 ? 0 : r);
  if (s === -1 || r === -1 || at === -1) {
    const exitAt = text.lastIndexOf(EXIT_MARK);
    const exitRaw = exitAt === -1 ? null : text.slice(exitAt + EXIT_MARK.length).split("\n")[0].trim();
    return { script: "", output: text, exit: exitRaw === null ? null : Number(exitRaw) };
  }
  const exitRaw = text.slice(at + EXIT_MARK.length).split("\n")[0].trim();
  // `cat` ends the echoed script with a newline, and the wrapper brackets the run
  // with a newline on each side. Drop exactly those so the script and the output
  // come back as they were written.
  const cut = (value) => value.replace(/\n$/, "");
  return {
    script: cut(text.slice(s + SCRIPT_MARK.length + 1, r)),
    output: cut(text.slice(r + RUN_MARK.length + 1, at)),
    exit: /^-?\d+$/.test(exitRaw) ? Number(exitRaw) : null,
  };
}

const queues = new Map();
function serialize(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next.then(() => {}, () => {}));
  return next;
}

// One script in a throwaway attacker container. `net` and `target` are the only
// differences between a lab replay and a live run, so both go through here.
//   toolset    attacker image (the pack's TOOLSET)
//   script     sh source
//   net        docker network for the script container
//   target     the host name the script sees as TOUCHSTONE_TARGET
//   work       host directory mounted at /work (default: none)
//   timeoutMs  wall clock; the container is killed past it
//   env        extra environment for the script
async function runScript({ toolset, script, net, target, work = null, timeoutMs = 180_000, env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "touchstone-session-"));
  try {
    writeFileSync(join(dir, "script.sh"), String(script), { mode: 0o644 });
    const args = [
      // --init: tini as PID 1 forwards the SIGTERM of a timeout, so a script
      // that leaves a child running (nc, a shell) is still reaped.
      "run", "--rm", "--init", "--pull=never", "--network", net,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      // The mounts come from the operator's own user: a root process without
      // CAP_DAC_OVERRIDE cannot traverse a 0700 staging dir or workspace. Run as
      // the caller so ownership matches, and whatever the script writes into
      // /work stays theirs.
      ...(process.getuid ? ["--user", `${process.getuid()}:${process.getgid()}`] : []),
      "--pids-limit", "256", "--memory", "1g",
      "-v", `${dir}:/run:ro`,
      ...(work ? ["-v", `${work}:/work`, "-w", "/work"] : []),
      "-e", `TOUCHSTONE_TARGET=${target}`,
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      "--entrypoint", "sh", toolset, "-c", wrapper(),
    ];
    const r = await docker(args, { timeoutMs });
    const parsed = parseRun(r.stdout);
    return { ...parsed, stderr: r.stderr.trim(), timedOut: r.timedOut, code: r.code };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// One script on the target's own lab network. Serialized per target: two scripts
// on one lab would interleave in the same container image and the same files.
export async function runTargetScript(handle, script, opts = {}) {
  return serialize(handle.targetName, () => runScript({ ...opts, script, net: handle.net, target: "target" }));
}

// One script against a real host. There is no lab and no per-target container: the
// script runs on the host bridge network and aims at the host name.
export async function runOpenScript(script, { net = "bridge", target, ...opts } = {}) {
  if (!target) throw new Error("a live script needs the target host");
  return serialize(`live:${target}`, () => runScript({ ...opts, script, net, target }));
}

// The whole replay for one finding: fresh target, fresh flag, the script, the
// oracle's read of the result, teardown. Returns the `proof` shape the app's
// proof cards expect for a session proof.
//   labOpts  { image, toolset, env, readyFile, before(dir), work }
//   script   the finding's shell script
//   oracle   { name, check(run, { flag }) -> { pass, detail } }
export async function sessionProof(labOpts, script, oracle) {
  const flag = newFlag();
  // Artifacts a lab has to BUILD must exist before its container starts, and the
  // container must see the same directory the script does.
  const scratch = labOpts.before ? mkdtempSync(join(tmpdir(), "touchstone-session-work-")) : null;
  try {
    if (scratch) await labOpts.before(scratch, { flag });
    const handle = await startTarget({ ...labOpts, flag, mount: scratch ?? labOpts.mount ?? null });
    try {
      const run = await runTargetScript(handle, script, {
        toolset: labOpts.toolset,
        work: scratch ?? labOpts.work ?? null,
        timeoutMs: labOpts.scriptTimeoutMs ?? 180_000,
        env: labOpts.scriptEnv ?? {},
      });
      let verdict;
      try {
        verdict = oracle.check(run, { flag: handle.flag });
      } catch (err) {
        verdict = { pass: false, detail: `oracle threw: ${String(err?.message || err).slice(0, 300)}` };
      }
      const detail = verdict.detail ?? "";
      return {
        kind: "session",
        status: verdict.pass ? "pass" : "fail",
        detail,
        oracle: { name: oracle.name ?? "", detail, passed: Boolean(verdict.pass) },
        log: [
          {
            label: "replayed script",
            request: { method: "sh", url: "script.sh", headers: {}, body: script },
            response: { status: run.exit, headers: {}, body: run.output },
          },
        ],
      };
    } finally {
      await stopTarget(handle);
    }
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- handle persistence across the prepass -> agent session -> prove boundary

const HANDLE_FILE = ".touchstone-session-lab.json";

// The flag is persisted with the handle: the agent's tool process is not the
// process that started the target, and the in-session MATCH check needs the
// value. It is therefore readable from the workspace, which is why the replay's
// flag differs and echoing a pasted flag never passes.
export function writeTargetHandle(ws, handle) {
  writeFileSync(join(ws, HANDLE_FILE), JSON.stringify({ net: handle.net, targetName: handle.targetName, image: handle.image, readyFile: handle.readyFile, flag: handle.flag }));
}

export function readTargetHandle(ws) {
  try {
    return JSON.parse(readFileSync(join(ws, HANDLE_FILE), "utf8"));
  } catch {
    return null;
  }
}

// Best effort; safe when nothing was ever started.
export async function teardownPersistedTarget(ws) {
  const handle = readTargetHandle(ws);
  if (!handle) return;
  try {
    await stopTarget(handle);
  } finally {
    try { rmSync(join(ws, HANDLE_FILE), { force: true }); } catch {}
  }
}
