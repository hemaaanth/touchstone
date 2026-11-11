// Isolation proof for the out-of-process attacker sandbox (F1 review R1,
// docs/fleet-orchestration.md §8). Run it:   node spike/lib/sandbox/proof.mjs
//
// Stands up a REAL Anvil cheat RPC in the R1-vulnerable posture (published on host loopback)
// and shows in one run:
//   A. BASELINE (no sandbox): an in-process attacker reaches that loopback RPC and forges a
//      credited drain via anvil_setBalance. This IS R1.
//   B. SANDBOXED: the same attacker, run out-of-process under bwrap (own pid+mount+net ns,
//      pivot_root'd minimal rootfs, caps dropped, fresh /proc), is CONTAINED — it cannot reach
//      the host by ANY path (docker socket, host procfs, host fs, host net), and the lab is
//      reachable ONLY through the read-only brokered unix socket.
//
// Exit 0 iff every assertion holds (containment + lab-reach). Recorded output: PROOF.txt.
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sandboxCapabilities, enter } from "./jail.mjs";
import { startBroker } from "./broker.mjs";
import { startAnvilLab, labImagePresent, rpc } from "./lab.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(...a);
const checks = [];
function check(name, pass, detail) { checks.push({ name, pass, detail }); log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`); }

async function main() {
  log("# Out-of-process attacker sandbox — isolation proof (F1 R1)\n");

  const cap = await sandboxCapabilities();
  log(`host sandbox capability: ${cap.ok ? "OK" : "UNAVAILABLE"} — ${cap.reason}`);
  if (!cap.ok) { log("\nCannot prove isolation without a real containment boundary. See README.md host prerequisites."); process.exit(2); }
  if (!(await labImagePresent())) { log("\nLab image missing (touchstone-chain-tools:wave1). Build/pull it first."); process.exit(2); }

  log("\nStarting REAL Anvil lab in the R1-vulnerable posture (published on host loopback)...");
  const lab = await startAnvilLab();
  const rundir = mkdtempSync(join(tmpdir(), "r1-broker-"));
  let broker;
  try {
    log(`lab container ${lab.name}, Anvil cheat RPC on host loopback ${lab.rpcUrl} (un-authed)\n`);

    // ---- A. BASELINE: in-process attacker reaches loopback and forges a drain (R1) ----
    log("## A. BASELINE (in-process, no sandbox) — reproduce R1");
    const b0 = (await rpc({ url: lab.rpcUrl }, "eth_getBalance", [lab.victim, "latest"]))?.result;
    const setR = await rpc({ url: lab.rpcUrl }, "anvil_setBalance", [lab.victim, "0x0"]);
    const b1 = (await rpc({ url: lab.rpcUrl }, "eth_getBalance", [lab.victim, "latest"]))?.result;
    log(`  victim balance ${b0} -> ${b1} via anvil_setBalance (no real vulnerability)`);
    check("in-process attacker reaches the lab on host loopback", b0 !== undefined && !setR?.error);
    check("in-process attacker forges a credited drain (R1 vector)", b0 !== b1 && b1 === "0x0",
      "this is exactly what the sandbox must make impossible");
    await rpc({ url: lab.rpcUrl }, "anvil_setBalance", [lab.victim, b0]); // restore for the end-state check

    // ---- broker: the one sanctioned path into the lab ----
    broker = await startBroker({ upstreamUrl: lab.rpcUrl, socketPath: join(rundir, "lab.sock") });
    log(`\nbroker: AF_UNIX read-only relay at ${broker.socketPath} -> lab (host side only)`);

    // ---- B. SANDBOXED: same attacker, out-of-process under bwrap ----
    log("\n## B. SANDBOXED (bwrap: own pid+mount+net ns, pivot_root, caps dropped, fresh /proc)");
    const run = await enter(["node", "/app/attacker.mjs"], {
      // Allowlisted env ONLY — never the host env (tokens/keys stay out of the untrusted child).
      setenv: { R1_LOOPBACK_URL: lab.rpcUrl, BROKER_SOCKET: "/lab/lab.sock", VICTIM: lab.victim },
      roBind: [
        [join(HERE, "attacker.mjs"), "/app/attacker.mjs"],
        [join(HERE, "lab.mjs"), "/app/lab.mjs"],
        [join(HERE, "probe.mjs"), "/app/probe.mjs"],
      ],
      bind: [[rundir, "/lab"]], // the broker-socket directory, and nothing else of the host
      timeoutMs: 45_000,
    });
    if (run.code !== 0 && !run.stdout.trim()) throw new Error(`sandboxed worker failed: ${run.stderr.trim() || run.code}`);
    const r = JSON.parse(run.stdout.trim());
    const c = r.containment, p = r.probes;
    log(`  containment: ${JSON.stringify(c)}`);
    log(`  lab probes:  ${JSON.stringify(p)}`);

    // Containment — every host-reaching vector dead (this is the fix the review demanded).
    check("sandbox containment holds (no host reach by any path)", c.contained === true,
      c.contained ? "docker socket absent+unreachable, fresh /proc, host fs invisible, empty netns" : `FAILURES: ${JSON.stringify(c.failures)}`);
    check("  · docker socket is absent inside the sandbox", c.detail?.dockerSockPresent?.length === 0);
    check("  · docker engine is unreachable over its socket", Object.values(c.detail?.engine ?? {}).every((v) => v !== "CONNECTED"),
      `connect results: ${JSON.stringify(c.detail?.engine)}`);
    check("  · /proc is fresh (host procfs not leaked, no /proc/<pid>/root escape)", !/\/sbin\/init|systemd/.test(c.detail?.pid1 ?? ""),
      `pid1=${c.detail?.pid1}, visiblePids=${JSON.stringify(c.detail?.visiblePids)}`);
    check("  · the mount mask cannot be removed (umount blocked, caps dropped)", String(c.detail?.umount).startsWith("blocked"),
      c.detail?.umount);
    check("  · host filesystem is invisible and the judge is unwritable", c.detail?.hostPathsVisible?.length === 0 && String(c.detail?.repoWritable).startsWith("no"),
      `visible=${JSON.stringify(c.detail?.hostPathsVisible)}, repoWritable=${c.detail?.repoWritable}`);

    // Lab reach — loopback dead, broker is the only path, and it is read-only.
    check("sandboxed attacker CANNOT reach the lab on host loopback",
      p.loopbackDrain?.reached === false, `connect error ${p.loopbackDrain?.error} — R1 drain impossible`);
    check("sandboxed attacker CAN reach the lab through the brokered IPC socket",
      p.brokerRead?.reached === true, `eth_chainId = ${p.brokerRead?.chainId}`);
    check("the broker rejects a forged drain (read-only policy at the boundary)",
      p.brokerDrain?.rejected === true && p.brokerDrain?.drained !== true, p.brokerDrain?.rejection);

    // Host-side confirmation: the whole sandboxed run left the lab unmutated.
    const bEnd = (await rpc({ url: lab.rpcUrl }, "eth_getBalance", [lab.victim, "latest"]))?.result;
    check("lab state is unmutated after the sandboxed run (no drain reached it)",
      bEnd === b0, `victim balance still ${bEnd}`);
  } finally {
    if (broker) await broker.close();
    await lab.stop();
    rmSync(rundir, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.pass);
  log(`\n# Result: ${failed.length === 0 ? "ALL PASS — R1 CLOSED" : `${failed.length} FAILED`}`);
  log(failed.length === 0
    ? "The attacker is contained out-of-process: it cannot reach the docker socket, the host\n" +
      "procfs, the host filesystem or the host network by any path, and the in-process loopback\n" +
      "drain (R1) is impossible. The only path to the lab is a read-only brokered unix socket.\n" +
      "R1 is closed for Tier-2 workers and F1 raw-tx replay alike — one sandbox, shared."
    : "");
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error("proof error:", e); process.exit(1); });
