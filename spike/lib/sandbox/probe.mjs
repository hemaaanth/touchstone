// Containment self-check, run FROM INSIDE the sandbox. Every check is a NEGATIVE assertion:
// each must fail to reach the host. This replaces the first cut's blind `stat(masked path)`,
// which the review caught green-lighting a boundary that did not hold. Node builtins only, so
// it runs with just itself bound into /app (no sibling imports).
import net from "node:net";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const DOCKER_SOCKS = ["/run/docker.sock", "/var/run/docker.sock"];
// Host paths that must be INVISIBLE inside the sandbox (absent => host fs not bound in).
const HOST_PATHS = ["/home", "/root/.ssh", "/home/hemanth/Projects/near/redteam-wt-sandbox/spike/lib/sandbox/proof.mjs"];
const REPO_WRITE_TARGET = "/home/hemanth/Projects/near/redteam-wt-sandbox/.sandbox-tamper-probe";

function tryUnixConnect(path) {
  return new Promise((r) => {
    const s = net.connect(path);
    s.on("connect", () => { s.destroy(); r("CONNECTED"); });
    s.on("error", (e) => r(e.code || String(e.message)));
    s.setTimeout(1500, () => { s.destroy(); r("timeout"); });
  });
}

// Returns { contained: bool, failures: [...], detail: {...} }. `failures` is empty iff every
// host-reaching vector is dead.
export async function containmentReport() {
  const d = {};
  const fail = [];

  // Bypass A — try to remove a mount mask. No CAP_SYS_ADMIN => must fail; /run shouldn't exist.
  try { execFileSync("umount", ["/run"], { stdio: "pipe" }); d.umount = "SUCCEEDED"; fail.push("umount /run succeeded"); }
  catch (e) { d.umount = "blocked:" + (e.stderr?.toString().trim().slice(0, 50) || e.status || e.code); }

  // docker socket present on any path?
  d.dockerSockPresent = DOCKER_SOCKS.filter((p) => { try { return existsSync(p); } catch { return false; } });
  if (d.dockerSockPresent.length) fail.push(`docker socket present: ${d.dockerSockPresent}`);

  // Reach the docker ENGINE over the socket (the actual escape — curl --unix-socket).
  d.engine = {};
  for (const p of DOCKER_SOCKS) { const r = await tryUnixConnect(p); d.engine[p] = r; if (r === "CONNECTED") fail.push(`docker engine reachable at ${p}`); }

  // Bypass B — fresh procfs. pid 1 must NOT be the host init; only sandbox pids; no host root.
  let pid1 = ""; try { pid1 = readFileSync("/proc/1/cmdline", "utf8").replace(/\0/g, " ").trim(); } catch (e) { pid1 = "ERR:" + e.code; }
  d.pid1 = pid1.slice(0, 60);
  if (/\/sbin\/init|systemd/.test(pid1)) fail.push("host procfs: pid1 is host init");
  const pids = (() => { try { return readdirSync("/proc").filter((x) => /^\d+$/.test(x)); } catch { return []; } })();
  d.visiblePids = pids;
  const otherRoot = pids.filter((p) => { try { return DOCKER_SOCKS.some((s) => existsSync(`/proc/${p}/root${s}`)); } catch { return false; } });
  if (otherRoot.length) fail.push(`docker socket reachable via /proc/<pid>/root (${otherRoot})`);

  // Host filesystem invisible (no secrets, no judge to tamper).
  d.hostPathsVisible = HOST_PATHS.filter((p) => { try { return existsSync(p); } catch { return false; } });
  if (d.hostPathsVisible.length) fail.push(`host paths visible: ${d.hostPathsVisible}`);
  try { writeFileSync(REPO_WRITE_TARGET, "x"); d.repoWritable = true; fail.push("repo is writable (judge tamperable)"); }
  catch (e) { d.repoWritable = "no:" + e.code; }

  // Empty net namespace: only loopback, no host NICs (preserves the TCP fence).
  let nics = [];
  try { nics = readFileSync("/proc/net/dev", "utf8").split("\n").map((l) => l.split(":")[0].trim()).filter((n) => n && !/Inter|face|^lo$/.test(n)); } catch { /* none */ }
  d.nonLoopbackNics = nics;
  if (nics.length) fail.push(`non-loopback NICs present: ${nics}`);

  return { contained: fail.length === 0, failures: fail, detail: d };
}

// CLI: print the report (used by sandboxCapabilities()).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(JSON.stringify(await containmentReport()));
}
