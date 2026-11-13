// No tool run may fetch an image (L35). Every `docker run` the engine builds in
// spike/lib and spike/packs carries `--pull=never` (one word: the only form the
// Daytona planner in lib/daytona.mjs accepts), or is a named exception below with
// its reason. Docker's default pull policy is `missing`, and `--network none`
// limits the container, not the daemon: without the flag a host that lacks the
// image fetches it, and a locally built tag is asked for on Docker Hub by name.
//
//   node --experimental-test-module-mocks --test test/docker-pull-never.test.mjs
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { imageGuard, planRemote } from "../lib/daytona.mjs";
import { FOUNDRY_IMAGE, forgeTest, forgeTestJson } from "../lib/sandbox.mjs";

const SPIKE = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Argument lists that run with no pull flag on purpose: none. (The four
// eth-security-toolbox lists carry the flag since the remote guard lets a Daytona
// machine pull a digest-pinned, `daytona: true` image itself; see lib/daytona.mjs.)
const ARGV_EXCEPTIONS = [];

// `docker run` written as shell text, not an argument list.
const SHELL_EXCEPTIONS = [
  { file: "lib/daytona.mjs", marker: "chown 1000:1000 /svm", reason: "warmScript runs ON the Daytona machine: it puts the pinned Foundry image and solc on the machine, with the network on purpose" },
  { file: "lib/daytona.mjs", marker: "forge build --use $V", reason: "warmScript, as above: the solc download needs the network" },
  { file: "lib/sandbox.mjs", marker: "chown 1000:1000 /svm", reason: "forgePrepareCommand: the README's prepare step a person runs once, online, on a fresh machine; it pulls the pinned image there on purpose (the replay runs with --pull never); not an engine run" },
  { file: "lib/sandbox.mjs", marker: "forge build --use ${v} W.sol", reason: "forgePrepareCommand, as above" },
];

function sources() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "vendor") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".mjs") && !name.endsWith(".test.mjs")) out.push(p);
    }
  };
  walk(join(SPIKE, "lib"));
  walk(join(SPIKE, "packs"));
  return out;
}

// Every array literal whose first element is "run" (or 'run'): a docker run argv.
function runLists(text) {
  const lists = [];
  for (const m of text.matchAll(/\[\s*(["'])run\1\s*,/g)) {
    let depth = 0;
    let end = m.index;
    for (; end < text.length; end++) {
      if (text[end] === "[") depth++;
      else if (text[end] === "]" && --depth === 0) break;
    }
    const line = text.slice(0, m.index).split("\n").length;
    lists.push({ line, body: text.slice(m.index, end + 1) });
  }
  return lists;
}

const PULL_NEVER = /(["'])--pull=never\1/;

test("every docker run argument list in spike/lib and spike/packs carries --pull=never, or is a named exception", () => {
  const files = sources();
  assert.ok(files.length > 50, `only ${files.length} source files scanned`);
  const used = new Set();
  const missing = [];
  let seen = 0;
  for (const path of files) {
    const rel = relative(SPIKE, path);
    for (const list of runLists(readFileSync(path, "utf8"))) {
      seen++;
      if (PULL_NEVER.test(list.body)) continue;
      const ex = ARGV_EXCEPTIONS.find((e) => e.file === rel && list.body.includes(e.marker));
      if (ex) { used.add(ex); continue; }
      missing.push(`${rel}:${list.line}`);
    }
  }
  assert.ok(seen >= 20, `only ${seen} docker run lists found: the scan is blind`);
  assert.deepEqual(missing, [], "docker run lists with no --pull=never (add the flag, or a named exception with a reason)");
  for (const e of ARGV_EXCEPTIONS) {
    assert.ok(used.has(e), `stale exception ${e.file} "${e.marker}": no flagless list matches it`);
    assert.ok(e.reason.length > 20, `${e.file}: an exception needs a reason`);
  }
});

test("every docker run written as shell text carries a pull-never flag, or is a named exception", () => {
  const used = new Set();
  const missing = [];
  for (const path of sources()) {
    const rel = relative(SPIKE, path);
    readFileSync(path, "utf8").split("\n").forEach((line, i) => {
      if (!/docker run /.test(line) || /^\s*\/\//.test(line)) return;
      if (/--pull[= ]never/.test(line)) return;
      const ex = SHELL_EXCEPTIONS.find((e) => e.file === rel && line.includes(e.marker));
      if (ex) { used.add(ex); return; }
      missing.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(missing, []);
  for (const e of SHELL_EXCEPTIONS) assert.ok(used.has(e), `stale exception ${e.file} "${e.marker}"`);
});

// A stub `docker` first on PATH. It records each argv and acts on the pull policy
// as docker does for an image that is not on the host: with --pull=never it fails
// at once ("No such image"); without it, it would fetch, so it writes PULL.
function withStubDocker(fn) {
  const root = mkdtempSync(join(tmpdir(), "l35-stub-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "argv.log");
  writeFileSync(join(bin, "docker"), [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > ${JSON.stringify(log)}`,
    `printf '%s\\n' '---' >> ${JSON.stringify(log)}`,
    'for a in "$@"; do [ "$a" = "--pull=never" ] && { echo "Unable to find image locally: No such image" >&2; exit 125; }; done',
    `echo PULL >> ${JSON.stringify(log)}`,
    "exit 1",
  ].join("\n"));
  chmodSync(join(bin, "docker"), 0o755);
  const saved = { PATH: process.env.PATH, TOUCHSTONE_EXEC: process.env.TOUCHSTONE_EXEC };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.TOUCHSTONE_EXEC = "local";
  const ws = join(root, "ws");
  mkdirSync(ws);
  const restore = () => {
    process.env.PATH = saved.PATH;
    if (saved.TOUCHSTONE_EXEC === undefined) delete process.env.TOUCHSTONE_EXEC;
    else process.env.TOUCHSTONE_EXEC = saved.TOUCHSTONE_EXEC;
    rmSync(root, { recursive: true, force: true });
  };
  return Promise.resolve(fn({ ws, argv: () => readFileSync(log, "utf8").split("\n---\n")[0].split("\n") , log: () => readFileSync(log, "utf8") })).finally(restore);
}

test("forgeTestJson passes --pull=never; a missing image fails with no pull attempt", async () => {
  await withStubDocker(async ({ ws, argv, log }) => {
    const r = await forgeTestJson(ws, { matchContract: "XTest", timeoutMs: 20_000 });
    const args = argv();
    assert.equal(args[0], "run");
    assert.ok(args.includes("--pull=never"), `no --pull=never in ${args.join(" ")}`);
    assert.deepEqual(args.slice(0, 5), ["run", "--rm", "--pull=never", "--network", "none"]);
    assert.doesNotMatch(log(), /PULL/, "the stub saw a run that would fetch the image");
    assert.equal(r.raw, "", "a failed run gives no JSON to judge");
    assert.match(r.stderr, /No such image/);
  });
});

test("the Daytona planner accepts the forgeTestJson argument list: it does not fall back to local", async () => {
  await withStubDocker(async ({ ws, argv }) => {
    await forgeTestJson(ws, { matchContract: "XTest", timeoutMs: 20_000 });
    const args = argv();
    const plan = planRemote(args, ws, "/r/ws");
    assert.equal(plan.local, null, `planRemote kept it local: ${plan.local}`);
    assert.match(plan.image, /^ghcr\.io\/foundry-rs\/foundry:latest@sha256:[0-9a-f]{64}$/);
    assert.ok(plan.args.includes("--pull=never"), "the flag reaches the machine's argv");
    assert.ok(plan.args.includes("/r/ws:/work"), "the workspace mount is rewritten");
  });
});

// L35, second part: a Daytona machine without Foundry pulls the pinned ref itself
// for both forge runs (an 862 MB upload from this host before). The guard the
// machine gets for the real argv of forgeTest and forgeTestJson pulls the ref.
for (const [name, run] of [["forgeTest", forgeTest], ["forgeTestJson", forgeTestJson]]) {
  test(`${name} on Daytona: a machine without Foundry pulls the pinned ref, it is not uploaded`, async () => {
    await withStubDocker(async ({ ws, argv }) => {
      await run(ws, { matchContract: "XTest", timeoutMs: 20_000 });
      const plan = planRemote(argv(), ws, "/r/ws");
      assert.equal(plan.local, null);
      assert.equal(plan.image, FOUNDRY_IMAGE);
      const guard = imageGuard(plan.args, plan.image, "/d");
      assert.ok(guard.includes(`docker pull -q '${FOUNDRY_IMAGE}'`), guard);
      assert.ok(plan.args.includes("--pull=never") && plan.args.includes("none"), "the run itself keeps --pull=never and --network none");
    });
  });
}
