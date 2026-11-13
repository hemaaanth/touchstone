// Shared helpers for wrapping an open-source tool as a pack tool.
//
// Every pack runs its tools the same way: one container per call, no network by
// default, no extra privileges, a time limit. The tool reads the workspace and
// writes JSON or SARIF. We parse that output into leads, the same lead shape the
// ensemble layer (ensemble.mjs) merges. A lead is never a finding.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { daytonaOn, remoteDocker } from "./daytona.mjs";

// Run one tool in Docker over the workspace, mounted at /work.
//   image    pinned image, e.g. "ghcr.io/trufflesecurity/trufflehog:3.90.0"
//            Never pulled: an image that is not local makes the call fail, and
//            the caller reports a coverage gap instead of reaching a registry.
//   cmd      the command, as an argv array
//   network  "none" unless the pack's TOOLS.md says the tool needs more
//   user     runs as the host user by default, so it can read the workspace
//            with no capabilities and its output files stay ours
//   addHosts [[name, ip], ...] pins each name to an address the caller checked
//            (--add-host). The container's resolver then points at an address
//            where nothing listens (--dns 127.0.0.1), so any other name fails.
//            A name must be a plain host name and an ip must parse; else it throws.
// Resolves (never rejects) with { code, stdout, stderr, timedOut }.
// Each container gets its own name, so a timeout can remove it. The tool's
// PID 1 ignores the SIGTERM the docker client forwards, so killing the client
// alone leaves the tool running.
//
// The container runs in local Docker by default. When Settings picks Daytona,
// it runs the same way on a Daytona machine instead (lib/daytona.mjs), with the
// same result shape. A call Daytona cannot serve runs locally.
//   entrypoint  override the image's entrypoint (e.g. "drill" in an image whose
//               default entrypoint is another tool). A plain binary name or an
//               absolute path only; anything with shell text throws. Omitted
//               (the default) means the argv is exactly as before.
//   mounts      extra mounts after the workspace: [[source, target, mode?], ...].
//               Read-only unless mode is "rw". See mountFlags for what is allowed.
//               A host path other than ws keeps a Daytona call on this host (planRemote).
//   mountRoots  host folders the caller made (for example its own mkdtemp
//               folder). A host-path mount must resolve under ws or one of these.
export async function runTool({ image, cmd, ws, network = "none", user = `${process.getuid()}:${process.getgid()}`, timeoutMs = 180_000, env = {}, maxBuffer = 64 * 1024 * 1024, addHosts = [], entrypoint = null, mounts = [], mountRoots = [] }) {
  const name = "touchstone-tool-" + randomBytes(6).toString("hex");
  const pins = hostPins(addHosts);
  const entry = entrypointFlag(entrypoint);
  const extra = mountFlags(mounts, [...(ws ? [ws] : []), ...mountRoots]);
  const args = [
    "run", "--rm", "--pull=never", "--network", network,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "512", "--memory", "2g", "--user", user,
    "--name", name,
    ...pins,
    ...entry,
    ...(ws ? ["-v", `${ws}:/work`, "-w", "/work"] : []),
    ...extra,
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    image, ...cmd,
  ];
  return runDocker(args, { ws, timeoutMs, maxBuffer, owner: user, name });
}

// The --entrypoint flag, or []. A plain binary name (letters, digits, _ . -) or an
// absolute path; each segment starts with a letter, digit or underscore (so no leading
// "-" option, no "." or ".." segment), and holds no spaces or shell metacharacters, so a
// value can never smuggle extra docker words or shell text. (--entrypoint is already a
// known value flag to Daytona's planner; a live-reach call keeps its non-none network,
// which keeps it local anyway.)
const ENTRYPOINT = /^(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+$|^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
export function entrypointFlag(entrypoint) {
  if (entrypoint == null) return [];
  if (typeof entrypoint !== "string" || !ENTRYPOINT.test(entrypoint)) throw new Error("runTool: entrypoint must be a plain binary name or absolute path: " + String(entrypoint).slice(0, 80));
  return ["--entrypoint", entrypoint];
}

// The -v flags for runTool's mounts, or [].
//   [hostPath, target]        read-only. hostPath is resolved with realpath
//                             (so a symlink is followed first) and must lie under
//                             one of roots (also resolved). It may not be, hold or
//                             lie inside "/", the home folder, spike/data or a
//                             docker socket.
//   [volume, target, "rw"]    read-write, only for a volume in RW_VOLUMES.
//   [volume, target]          read-only, same allow-list.
// target is an absolute container path. No value may hold ":" or "," or a
// "." / ".." segment, so it cannot add a mount option or a docker word.
export const RW_VOLUMES = new Set(["foundry-svm", "touchstone_svm_cache"]); // the solc cache
const MOUNT_PATH = /^(?:\/[A-Za-z0-9_.@+-]+)+$/;
const SPIKE_DATA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "data");
const under = (child, parent) => {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
export function mountFlags(mounts, roots = []) {
  if (!Array.isArray(mounts)) throw new Error("mounts must be a list of [source, target, mode?]");
  if (!mounts.length) return [];
  if (!Array.isArray(roots)) throw new Error("mounts: roots must be a list of folders");
  const syntax = (p) => typeof p === "string" && MOUNT_PATH.test(p) && !p.split("/").some((seg) => seg === "." || seg === "..");
  const home = real(homedir());
  const forbidden = ["/", home, real(SPIKE_DATA)];
  const allowed = roots.map((r) => {
    if (!syntax(r)) throw new Error("mounts: bad root: " + String(r).slice(0, 80));
    const rr = real(r);
    if (forbidden.some((f) => under(f, rr))) throw new Error("mounts: root is too wide: " + rr);
    return rr;
  });
  return mounts.flatMap((m) => {
    const [src, dst, mode, ...rest] = Array.isArray(m) ? m : [];
    if (!syntax(dst)) throw new Error("mounts: bad target: " + String(dst).slice(0, 80));
    if (rest.length || (mode !== undefined && mode !== "ro" && mode !== "rw")) throw new Error('mounts: mode must be "ro" or "rw"');
    if (typeof src === "string" && RW_VOLUMES.has(src)) return ["-v", `${src}:${dst}${mode === "rw" ? "" : ":ro"}`];
    if (!syntax(src)) throw new Error("mounts: source must be an absolute host path or an allowed volume (" + [...RW_VOLUMES].join(", ") + "): " + String(src).slice(0, 80));
    if (mode === "rw") throw new Error("mounts: a host path is read-only; rw is only for " + [...RW_VOLUMES].join(", "));
    if (under(resolve(src), SPIKE_DATA)) throw new Error("mounts: refused, spike/data is never mounted: " + src);
    let path;
    try {
      path = realpathSync(src);
    } catch {
      throw new Error("mounts: source does not exist: " + src);
    }
    if (/(^|\/)docker\.sock$/.test(path) || /(^|\/)docker\.sock$/.test(src)) throw new Error("mounts: a docker socket is never mounted: " + src);
    if (forbidden.some((f) => under(f, path)) || under(path, real(SPIKE_DATA))) throw new Error("mounts: refused, the folder is / , the home folder, spike/data, or holds one of them: " + path);
    if (!allowed.some((r) => under(path, r))) throw new Error("mounts: " + path + " is outside the allowed roots (the workspace or a folder the caller made)");
    return ["-v", `${path}:${dst}:ro`];
  });
}

// The docker flags for addHosts. Daytona's parser does not know --add-host or
// --dns, so a call that carries them always runs on local Docker.
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
export function hostPins(addHosts) {
  if (!Array.isArray(addHosts)) throw new Error("addHosts must be a list of [name, ip] pairs");
  if (!addHosts.length) return [];
  const out = [];
  for (const pair of addHosts) {
    const [host, ip] = Array.isArray(pair) ? pair : [];
    if (typeof host !== "string" || !HOST_NAME.test(host) || isIP(host)) throw new Error("addHosts: not a plain host name: " + String(host).slice(0, 80));
    // A zone id (fe80::1%eth0) names a host interface, which means nothing inside a
    // container; isIP accepts it, so refuse it here with a clear message.
    if (typeof ip === "string" && ip.includes("%")) throw new Error("addHosts: an IPv6 zone id is not allowed in a pinned address: " + ip.slice(0, 80));
    if (typeof ip !== "string" || !isIP(ip)) throw new Error("addHosts: not an IP address: " + String(ip).slice(0, 80));
    out.push("--add-host", host + ":" + ip);
  }
  return [...out, "--dns", "127.0.0.1"];
}

// Run one `docker run` argv on the chosen backend: a Daytona machine when
// Settings picks Daytona and the call can go there, else local Docker. ws is
// the host dir the argv mounts; on Daytona its changed files come back.
// runTool uses this. A module that needs its own docker flags (an entrypoint,
// the image's own user) calls it directly, so it still honors the backend.
// root names the calling run when ws is a dir outside it (a fuzz scratch dir).
// name is the --name in args. On local Docker, a timeout then removes that
// container, so the call returns near timeoutMs and reports timedOut.
// Resolves (never rejects) with { code, stdout, stderr, timedOut }.
export async function runDocker(args, { ws = null, timeoutMs = 180_000, maxBuffer = 64 * 1024 * 1024, owner, skipBack, root = null, stream = null, name = null } = {}) {
  if (daytonaOn()) {
    const remote = await remoteDocker(args, { ws, timeoutMs, maxBuffer, owner, skipBack, root });
    if (remote) return remote;
  }
  return new Promise((resolve) => {
    // With a name, a timeout removes the container, and the client then exits
    // by itself. The client is not killed at timeoutMs: a client killed
    // during create leaves the daemon to create a container after every
    // rm -f has run. So rm -f repeats until the client exits. SIGKILL 30 s
    // later is only the last stop. Each rm -f gets 5 s, so a hung daemon
    // adds at most 5 s after the client exits.
    let expired = false, exited = false, sweep = null;
    const remove = (done) => execFile("docker", ["rm", "-f", name], { timeout: 5_000, killSignal: "SIGKILL" }, () => done());
    const again = () => remove(() => { if (!exited) sweep = setTimeout(again, 250); });
    const timer = name ? setTimeout(() => { expired = true; again(); }, timeoutMs) : null;
    const kill = name ? { timeout: timeoutMs + 30_000, killSignal: "SIGKILL" } : { timeout: timeoutMs };
    const child = execFile("docker", args, { ...kill, maxBuffer }, (err, stdout, stderr) => {
      exited = true;
      clearTimeout(timer);
      clearTimeout(sweep);
      // A removed container can still exit 0. A timeout is never a success.
      const done = () => resolve({
        code: expired ? (err && typeof err.code === "number" && err.code ? err.code : 124) : err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        timedOut: expired || Boolean(err?.killed),
      });
      // One last rm -f, and wait for it, so nothing is left at return.
      if (expired) remove(done); else done();
    });
    // Optional live tee. The callback still receives the full buffers; this is
    // only so a long engine can report progress before it exits.
    if (stream) {
      child.stdout?.on("data", (d) => stream("stdout", String(d)));
      child.stderr?.on("data", (d) => stream("stderr", String(d)));
    }
  });
}

// SARIF level or security-severity -> our impact words (see IMPACT_RANK).
function impactOf(result, rule) {
  const sev = Number(result.properties?.["security-severity"] ?? rule?.properties?.["security-severity"]);
  if (Number.isFinite(sev)) return sev >= 7 ? "High" : sev >= 4 ? "Medium" : sev > 0 ? "Low" : "Informational";
  const level = result.level ?? rule?.defaultConfiguration?.level ?? "warning";
  return { error: "High", warning: "Medium", note: "Low" }[level] ?? "Informational";
}

// Turn a SARIF 2.1.0 log into leads for one engine. Paths are made relative to
// /work, so they match the workspace paths the agent reads.
export function sarifLeads(sarif, engine) {
  const log = typeof sarif === "string" ? JSON.parse(sarif) : sarif;
  const leads = [];
  for (const run of log?.runs ?? []) {
    const rules = new Map((run.tool?.driver?.rules ?? []).map((r) => [r.id, r]));
    for (const r of run.results ?? []) {
      const rule = rules.get(r.ruleId) ?? (r.ruleIndex != null ? run.tool?.driver?.rules?.[r.ruleIndex] : undefined);
      const loc = r.locations?.[0];
      const phys = loc?.physicalLocation;
      const file = phys?.artifactLocation?.uri?.replace(/^file:\/\//, "").replace(/^\/work\//, "") ?? null;
      const line = phys?.region?.startLine;
      leads.push({
        engine,
        check: r.ruleId ?? rule?.id ?? "unknown",
        impact: impactOf(r, rule),
        confidence: rule?.properties?.precision ?? null,
        file,
        lines: Number.isInteger(line) ? [line] : [],
        where: loc?.logicalLocations?.[0]?.fullyQualifiedName ?? loc?.logicalLocations?.[0]?.name ?? null,
        description: r.message?.text ?? rule?.shortDescription?.text ?? "",
      });
    }
  }
  return leads;
}
