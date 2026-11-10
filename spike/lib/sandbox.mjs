// Per-run Foundry sandbox. Each run gets its own copy of the target repo, so the
// agent's writes never touch the real lab and runs are isolated (decision 2:
// one Docker sandbox per run). Runs are offline: --network none plus a warmed
// solc cache volume. See lab/vault-reentrancy; warm the cache once with:
//   docker volume create foundry-svm
//   docker run --rm -u 0 --entrypoint sh -v foundry-svm:/svm IMG -c 'chown 1000:1000 /svm'
//   (cd lab/vault-reentrancy && docker run --rm -v foundry-svm:/home/foundry/.svm -v "$PWD":/work -w /work IMG 'forge build')
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

const IMG = "ghcr.io/foundry-rs/foundry:latest";
const SOLC = "0.8.38";
const SVM_VOLUME = "foundry-svm";

// Build an isolated workspace from a target repo. We copy only what the agent is
// allowed to see: contract source, the vendored libs, and the build config. The
// oracle/ directory is never copied, so the agent cannot read the reference exploit.
export function makeWorkspace(targetDir) {
  const ws = mkdtempSync(join(tmpdir(), "redteam-run-"));
  cpSync(join(targetDir, "src"), join(ws, "src"), { recursive: true });
  cpSync(join(targetDir, "lib"), join(ws, "lib"), { recursive: true });
  cpSync(join(targetDir, "foundry.toml"), join(ws, "foundry.toml"));
  mkdirSync(join(ws, "test"), { recursive: true });
  return ws;
}

export function cleanupWorkspace(ws) {
  rmSync(ws, { recursive: true, force: true });
}

// Write the agent's PoC into the workspace test dir. One fixed filename so a
// second run_poc call overwrites the first rather than piling up test files.
export function writePoc(ws, source) {
  writeFileSync(join(ws, "test", "AgentPoc.t.sol"), source);
}

// Forge prints hundreds of forge-std deprecation warnings before the real
// compile error or test result. Drop the warning blocks so the agent sees the
// signal (errors, reverts, PASS/FAIL, logs) instead of noise.
export function distill(output) {
  const lines = output.split("\n");
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    if (/There are more than \d+ warnings/.test(line)) continue; // standalone, not a block
    if (/^Warning \(\d+\):/.test(line)) { skipping = true; continue; }
    if (skipping) {
      if (line.trim() === "") { skipping = false; } // blank line ends a warning block
      continue;
    }
    kept.push(line);
  }
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const arr = text.split("\n");
  return arr.length > 80 ? arr.slice(-80).join("\n") : text; // errors/results live at the end
}

const run = (args, timeoutMs) =>
  new Promise((resolve) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout), stderr: String(stderr), timedOut: err?.killed === true, code: err?.code ?? 0 });
    });
  });

// Run `forge test` on the workspace inside the offline container. matchContract,
// if given, limits to one test contract. Returns combined output and a pass flag.
export async function forgeTest(ws, { matchContract, timeoutMs = 180_000 } = {}) {
  let cmd = `forge test --offline --use ${SOLC} -vv`;
  if (matchContract) cmd += ` --match-contract ${matchContract}`;
  const args = [
    "run", "--rm", "--network", "none",
    "-v", `${SVM_VOLUME}:/home/foundry/.svm`,
    "-v", `${ws}:/work`, "-w", "/work",
    IMG, cmd,
  ];
  const r = await run(args, timeoutMs);
  const raw = (r.stdout + r.stderr).trim();
  const passed = /\b([1-9]\d*) passed; 0 failed/.test(raw);
  const failed = /[1-9]\d* failed/.test(raw) || /compilation failed|Compilation failed|Error \(\d+\)|Error:/i.test(raw);
  return { output: distill(raw), passed, failed, timedOut: r.timedOut };
}
