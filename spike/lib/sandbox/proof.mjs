// Isolation proof for the out-of-process attacker sandbox (F1 review R1,
// docs/fleet-orchestration.md §8). Run it:   node spike/lib/sandbox/proof.mjs
//
// It stands up a REAL Anvil cheat RPC in the R1-vulnerable posture (published on host
// loopback) and shows, in one run:
//   A. BASELINE (no sandbox): an in-process attacker reaches that loopback RPC and forges a
//      credited drain via anvil_setBalance. This IS R1 — the reason the review blocked.
//   B. SANDBOXED: the same attacker, run out-of-process in its own netns with no host network
//      and no docker socket, (1) CANNOT reach the loopback RPC, (2) has NO docker socket, and
//      (3) reaches the lab ONLY through the brokered unix socket — where a drain is rejected.
//
// Exit 0 iff every assertion holds. Recorded output lives alongside this file (PROOF.txt).
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sandboxCapabilities, enter } from "./netns.mjs";
import { startBroker } from "./broker.mjs";
import { startAnvilLab, labImagePresent, rpc } from "./lab.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ATTACKER = join(HERE, "attacker.mjs");
const log = (...a) => console.log(...a);
const checks = [];
function check(name, pass, detail) { checks.push({ name, pass, detail }); log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`); }

async function main() {
  log("# Out-of-process attacker sandbox — isolation proof (F1 R1)\n");

  const cap = await sandboxCapabilities();
  log(`host sandbox capability: ${cap.ok ? "OK" : "UNAVAILABLE"} — ${cap.reason}`);
  if (!cap.ok) { log("\nCannot prove isolation without namespaces. See README.md host prerequisites."); process.exit(2); }
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
    // Restore the victim so the END-STATE check below is meaningful: if the broker path ever
    // mutated the lab, the final balance would differ from this restored value.
    await rpc({ url: lab.rpcUrl }, "anvil_setBalance", [lab.victim, b0]);

    // ---- broker: the one sanctioned path into the lab ----
    broker = await startBroker({ upstreamUrl: lab.rpcUrl, socketPath: join(rundir, "lab.sock") });
    log(`\nbroker: AF_UNIX read-only relay at ${broker.socketPath} -> lab (host side only)`);

    // ---- B. SANDBOXED: same attacker, out-of-process, isolated ----
    log("\n## B. SANDBOXED (out-of-process: own netns, no host net, no docker socket)");
    const run = await enter(["node", ATTACKER], {
      env: {
        ...process.env,
        R1_LOOPBACK_URL: lab.rpcUrl,       // handed deliberately: KNOWING it must not help
        BROKER_SOCKET: broker.socketPath,  // the only sanctioned channel
        VICTIM: lab.victim,
      },
      timeoutMs: 45_000,
    });
    if (run.code !== 0 && !run.stdout.trim()) throw new Error(`sandboxed worker failed: ${run.stderr.trim() || run.code}`);
    const r = JSON.parse(run.stdout.trim());
    const p = r.probes;
    log(`  worker probes: ${JSON.stringify(p)}`);

    check("sandboxed attacker CANNOT reach the lab on host loopback",
      p.loopbackDrain?.reached === false, `connect error ${p.loopbackDrain?.error} — R1 drain impossible`);
    check("sandboxed attacker has NO docker socket",
      Array.isArray(p.dockerSocket?.present) && p.dockerSocket.present.length === 0,
      "cannot `docker port` the labelled lab container");
    check("sandboxed attacker CAN reach the lab through the brokered IPC socket",
      p.brokerRead?.reached === true, `eth_chainId = ${p.brokerRead?.chainId}`);
    check("the broker rejects a forged drain (read-only policy at the boundary)",
      p.brokerDrain?.rejected === true && p.brokerDrain?.drained !== true, p.brokerDrain?.rejection);

    // Independently confirm, from the HOST side, that the whole sandboxed run left the lab
    // unmutated: the victim balance is still the value we restored, so no drain reached it.
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
    ? "The in-process loopback drain (R1) is impossible from the sandbox; the only path to the\n" +
      "lab is the brokered unix socket, which is read-only. R1 is closed for Tier-2 workers and\n" +
      "F1 raw-tx replay alike — one sandbox, shared."
    : "");
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error("proof error:", e); process.exit(1); });
