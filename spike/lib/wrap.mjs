// Shared helpers for wrapping an open-source tool as a pack tool.
//
// Every pack runs its tools the same way: one container per call, no network by
// default, no extra privileges, a time limit. The tool reads the workspace and
// writes JSON or SARIF. We parse that output into leads, the same lead shape the
// ensemble layer (ensemble.mjs) merges. A lead is never a finding.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { daytonaOn, remoteDocker } from "./daytona.mjs";
import { runCapture } from "./capture.mjs";

// Run one tool in Docker over the workspace, mounted at /work.
//   image    pinned image, e.g. "ghcr.io/trufflesecurity/trufflehog:3.90.0"
//            Never pulled: an image that is not local makes the call fail, and
//            the caller reports a coverage gap instead of reaching a registry.
//   cmd      the command, as an argv array
//   network  "none" unless the pack's TOOLS.md says the tool needs more
//   user     runs as the host user by default, so it can read the workspace
//            with no capabilities and its output files stay ours
// Resolves (never rejects) with { code, stdout, stderr, timedOut }.
// Each container gets its own name, so a timeout can remove it. The tool's
// PID 1 ignores the SIGTERM the docker client forwards, so killing the client
// alone leaves the tool running.
//
// The container runs in local Docker by default. When Settings picks Daytona,
// it runs the same way on a Daytona machine instead (lib/daytona.mjs), with the
// same result shape. A call Daytona cannot serve runs locally.
//
// capture  OFF by default. An object { reach, targets, hosts, secrets } turns on
//          capture mode (lib/capture.mjs): the one way a tool gets the network.
//          It needs a grant that covers the targets, runs behind an egress
//          allow-list, keeps --pull=never, and passes secrets by env name only.
//          `network` is ignored in this mode. Capture runs on local Docker only.
export async function runTool({ image, cmd, ws, network = "none", user = `${process.getuid()}:${process.getgid()}`, timeoutMs = 180_000, env = {}, maxBuffer = 64 * 1024 * 1024, capture = null }) {
  if (capture) {
    // Only these four. confine and exec are runCapture's test seams, not options.
    const { reach, targets, hosts, secrets } = capture;
    return runCapture({ reach, targets, hosts, secrets, image, cmd, ws, user, env, timeoutMs, maxBuffer });
  }
  const name = "touchstone-tool-" + randomBytes(6).toString("hex");
  const args = [
    "run", "--rm", "--pull=never", "--network", network,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "512", "--memory", "2g", "--user", user,
    "--name", name,
    ...(ws ? ["-v", `${ws}:/work`, "-w", "/work"] : []),
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    image, ...cmd,
  ];
  return runDocker(args, { ws, timeoutMs, maxBuffer, owner: user, name });
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
