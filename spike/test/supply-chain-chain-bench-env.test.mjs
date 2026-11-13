// The chain-bench image reads the GitHub token from SCM_TOKEN, never from argv
// (G9). Real Docker, a fake token, no network: --network none and a local proxy
// that never answers, so chain-bench waits on its first request while the test
// reads every process's command line, inside the container and on the host
// (a container's processes are host processes: the host `ps` shows them).
// The token is passed by name only: `-e SCM_TOKEN`, its value in the docker
// client's own environment. Skips with a reason when the image is not built.
//
//   node --test spike/test/supply-chain-chain-bench-env.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

// CHAIN_BENCH_ENV_IMAGE lets a mutant image be checked against the same test.
const IMAGE = process.env.CHAIN_BENCH_ENV_IMAGE || "touchstone/chain-bench:0.1.10-env";
const missing = (() => { try { execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }); return false; } catch { return `${IMAGE} is not built (spike/scripts/setup.mjs --only supply-chain --include-optional)`; } })();
const FAKE = `ghp_FAKE${randomBytes(16).toString("hex")}`; // never a real token
const MARK = `touchstone-env-test-${randomBytes(4).toString("hex")}`; // in chain-bench's own argv

// Every readable command line on the host, as text.
function hostCmdlines() {
  const out = [];
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try { out.push(readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ")); } catch { /* gone, or not ours to read */ }
  }
  return out;
}

// Run `script` with sh in the image, the token by name only. When the script
// prints SCAN, the host's command lines are read. Resolves { inside, host, code }.
function runScript(script, { env = { SCM_TOKEN: FAKE } } = {}) {
  const name = `touchstone-cb-env-${randomBytes(4).toString("hex")}`;
  const args = ["run", "--rm", "--pull=never", "--name", name, "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    ...Object.keys(env).flatMap((k) => ["-e", k]), "-e", "HTTPS_PROXY=http://127.0.0.1:3128", "--entrypoint", "sh", IMAGE, "-c", script];
  assert.ok(!args.join(" ").includes(FAKE), "the docker argv holds the token");
  return new Promise((resolve) => {
    const p = spawn("docker", args, { env: { ...process.env, ...env } });
    let out = "", host = null;
    p.stdout.on("data", (d) => { out += d; if (host === null && out.includes("SCAN\n")) host = hostCmdlines(); });
    p.stderr.on("data", (d) => { out += d; });
    const stop = setTimeout(() => execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }), 60_000);
    p.on("close", (code) => { clearTimeout(stop); resolve({ inside: out, host: host ?? [], code }); });
  });
}
// The proxy that never answers (nc keeps an open stdin, or it closes the
// connection at once and chain-bench exits before anything is read), then the
// tool. ALIVE and TOOL: show the tool itself was still running and its own
// command line; then every command line in the container; then the host scan.
const LIST = 'for p in /proc/[0-9]*; do [ -r "$p/cmdline" ] && tr "\\000" " " < "$p/cmdline" && echo; done';
const scan = (tool) => `sleep 30 | nc -l -p 3128 >/dev/null 2>&1 & sleep 0.5; ${tool} >/dev/null 2>&1 & T=$!; sleep 2; ` +
  `[ -d /proc/$T ] && echo ALIVE && printf 'TOOL: ' && tr "\\000" " " < /proc/$T/cmdline && echo; ${LIST}; echo SCAN; sleep 2; kill $T 2>/dev/null; exit 0`;

test("chain-bench gets the token from SCM_TOKEN: it is in no command line, inside the container or on the host", { skip: missing, timeout: 90_000 }, async () => {
  const r = await runScript(scan(`/usr/local/bin/chain-bench scan --repository-url https://github.com/example-org/${MARK} -o /tmp/out.json -q`));
  // chain-bench itself was still running, and its own command line was read
  // (the outer script holds the marker too, so it is excluded by "nc -l")...
  assert.match(r.inside, /^ALIVE$/m, "chain-bench exited before its command line was read");
  const tool = r.inside.split("\n").find((l) => l.startsWith("TOOL: "));
  assert.ok(tool && tool.includes(MARK), "the tool's own command line was not read");
  assert.ok(r.host.some((c) => c.includes(MARK) && !c.includes("nc -l")), "the host did not see the tool's own command line");
  assert.equal(tool.includes(FAKE), false, "the token is in chain-bench's own command line");
  // ...and the token is in none of them.
  assert.equal(r.inside.includes(FAKE), false, "the token is in a command line inside the container");
  assert.equal(r.host.filter((c) => c.includes(FAKE)).length, 0, "the token is in a host command line");
});

test("control: a token put on a command line is seen by the same host scan", { skip: missing, timeout: 90_000 }, async () => {
  // What a shell entrypoint that passes `-t "$SCM_TOKEN"` would do.
  const r = await runScript(`sh -c 'sleep 6; :' "$SCM_TOKEN" & sleep 1; echo SCAN; sleep 1; exit 0`);
  assert.ok(r.host.some((c) => c.includes(FAKE)), "the host scan is blind: it did not see a token in argv");
});

test("chain-bench refuses a token flag on the command line, in every form the flag parser takes, and a missing SCM_TOKEN", { skip: missing, timeout: 120_000 }, async () => {
  const URL = "https://github.com/example-org/example-repo";
  // Separate value, = value, glued value, and a cluster of short flags that reaches t.
  for (const flag of ["-t x", "--access-token x", "--access-token=VALUE", "-t=VALUE", "-tVALUE", "-qtVALUE", "-vqtVALUE"]) {
    const r = await runScript(`/usr/local/bin/chain-bench scan --repository-url ${URL} ${flag}; echo "exit=$?"`);
    assert.match(r.inside, /a token flag on the command line is refused/, flag);
    assert.match(r.inside, /exit=2/, flag);
  }
  // Not the token: a value flag's own value may hold a t (-o takes the rest of the cluster).
  for (const flag of ["-o/tmp/t.json", "-qo/tmp/t.json"]) {
    const r = await runScript(`/usr/local/bin/chain-bench scan --repository-url ${URL} ${flag}; echo "exit=$?"`);
    assert.doesNotMatch(r.inside, /token flag on the command line is refused/, flag);
  }
  const none = await runScript(`/usr/local/bin/chain-bench scan --repository-url ${URL}; echo "exit=$?"`, { env: {} });
  assert.match(none.inside, /SCM_TOKEN is not set/);
  assert.match(none.inside, /exit=2/);
});
