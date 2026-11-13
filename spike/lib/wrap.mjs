// Shared helpers for wrapping an open-source tool as a pack tool.
//
// Every pack runs its tools the same way: one container per call, no network by
// default, no extra privileges, a time limit. The tool reads the workspace and
// writes JSON or SARIF. We parse that output into leads, the same lead shape the
// ensemble layer (ensemble.mjs) merges. A lead is never a finding.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { daytonaOn, remoteDocker } from "./daytona.mjs";

// Run one tool in Docker over the workspace, mounted at /work.
//   image    pinned image, e.g. "ghcr.io/trufflesecurity/trufflehog:3.90.0"
//            Never pulled: an image that is not local makes the call fail, and
//            the caller reports a coverage gap instead of reaching a registry.
//   cmd      the command, as an argv array
//   network  "none" unless the pack's TOOLS.md says the tool needs more
//   user     runs as the host user by default, so it can read the workspace
//            with no capabilities and its output files stay ours
// Resolves (never rejects) with { code, stdout, stderr, timedOut }.
//
// Each container has its own name, so a timeout can really stop it (see
// runDocker).
//
// The container runs in local Docker by default. When Settings picks Daytona,
// it runs the same way on a Daytona machine instead (lib/daytona.mjs), with the
// same result shape. A call Daytona cannot serve runs locally.
export async function runTool({ image, cmd, ws, network = "none", user = `${process.getuid()}:${process.getgid()}`, timeoutMs = 180_000, env = {}, maxBuffer = 64 * 1024 * 1024 }) {
  const name = `touchstone-tool-${randomBytes(6).toString("hex")}`;
  const args = [
    "run", "--rm", "--pull=never", "--name", name, "--network", network,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "512", "--memory", "2g", "--user", user,
    ...(ws ? ["-v", `${ws}:/work`, "-w", "/work"] : []),
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    image, ...cmd,
  ];
  return runDocker(args, { ws, timeoutMs, maxBuffer, owner: user, name });
}

// Remove a container by name. The daemon may still be creating it, so try a
// few times. Never rejects. On Daytona the remote watchdog removes its own
// container, and this finds nothing here.
async function removeContainer(name) {
  const docker = (args) => new Promise((done) => execFile("docker", args, { timeout: 20_000 }, (err, out) => done(err ? "" : String(out).trim())));
  for (const wait of [0, 1000, 2000]) {
    await sleep(wait);
    await docker(["rm", "-f", name]);
  }
  if (await docker(["ps", "-aq", "--filter", `name=^${name}$`])) await docker(["rm", "-f", name]);
}

// Run one `docker run` argv on the chosen backend: a Daytona machine when
// Settings picks Daytona and the call can go there, else local Docker. ws is
// the host dir the argv mounts; on Daytona its changed files come back.
// runTool uses this. A module that needs its own docker flags (an entrypoint,
// the image's own user) calls it directly, so it still honors the backend.
// root names the calling run when ws is a dir outside it (a fuzz scratch dir).
// name is the --name in args. With it, a local timeout really stops the tool:
// an attached docker client sends SIGTERM to the container and waits, and a tool
// that runs as PID 1 ignores SIGTERM. So at timeoutMs the container is removed
// with `docker rm -f`, which also ends the client. On Daytona the remote
// watchdog does this.
// Resolves (never rejects) with { code, stdout, stderr, timedOut }.
export async function runDocker(args, { ws = null, timeoutMs = 180_000, maxBuffer = 64 * 1024 * 1024, owner, skipBack, root = null, stream = null, name = null } = {}) {
  if (daytonaOn()) {
    const remote = await remoteDocker(args, { ws, timeoutMs, maxBuffer, owner, skipBack, root });
    if (remote) return remote;
  }
  return new Promise((resolve) => {
    let late = false;
    const stop = name ? setTimeout(() => { late = true; removeContainer(name); }, timeoutMs) : null;
    // With a name, the client kill is only a backstop.
    const child = execFile("docker", args, { timeout: name ? timeoutMs + 30_000 : timeoutMs, maxBuffer }, (err, stdout, stderr) => {
      clearTimeout(stop);
      const timedOut = late || Boolean(err?.killed);
      const result = {
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        timedOut,
      };
      // A client killed before the container started leaves it "Created".
      if (timedOut && name) removeContainer(name).then(() => resolve(result));
      else resolve(result);
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
