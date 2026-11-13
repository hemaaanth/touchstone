// No tool run may fetch an image (L35). Every `docker run` or `docker create` the
// code builds carries `--pull=never` (one word: the only form the Daytona planner
// in lib/daytona.mjs accepts), or is a named exception below with its reason.
// Docker's default pull policy is `missing`, and `--network none` limits the
// container, not the daemon: without the flag a host that lacks the image fetches
// it, and a locally built tag is asked for on Docker Hub by name.
//
// Scope (L35b): spike/lib, spike/packs, the top-level spike/*.mjs, spike/scripts
// and app/server. Forms: an argument list that starts with "run" or "create", or
// with "container", "run"|"create"; and `docker run` / `docker create` /
// `docker container run|create` written as shell text, also split over a `+`.
//
//   node --experimental-test-module-mocks --test test/docker-pull-never.test.mjs
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { imageGuard, planRemote } from "../lib/daytona.mjs";
import { FOUNDRY_IMAGE, forgeTest, forgeTestJson } from "../lib/sandbox.mjs";

const SPIKE = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROOT = resolve(SPIKE, "..");

// Argument lists with no pull flag on purpose. `marker` is text inside the list,
// or before it on its line; an entry that matches no list fails the test.
const ARGV_EXCEPTIONS = [
  { file: "spike/smoke-durable.mjs", marker: "runChild(", reason: "not docker: `run` is the engine CLI's own verb (runChild spawns node agent-run.mjs run …)" },
];

// `docker run` written as shell text, not an argument list.
const SHELL_EXCEPTIONS = [
  { file: "spike/lib/daytona.mjs", marker: "chown 1000:1000 /svm", reason: "warmScript runs ON the Daytona machine: it puts the pinned Foundry image and solc on the machine, with the network on purpose" },
  { file: "spike/lib/daytona.mjs", marker: "forge build --use $V", reason: "warmScript, as above: the solc download needs the network" },
  { file: "spike/lib/sandbox.mjs", marker: "chown 1000:1000 /svm", reason: "forgePrepareCommand: the README's prepare step a person runs once, online, on a fresh machine; it pulls the pinned image there on purpose (the replay runs with --pull never); not an engine run" },
  { file: "spike/lib/sandbox.mjs", marker: "forge build --use ${v} W.sol", reason: "forgePrepareCommand, as above" },
];

// The code a docker call may come from: never tests, never vendored or installed code.
function sources() {
  const out = [];
  const take = (p) => p.endsWith(".mjs") && !p.endsWith(".test.mjs") && out.push(p);
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "vendor") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else take(p);
    }
  };
  walk(join(SPIKE, "lib"));
  walk(join(SPIKE, "packs"));
  walk(join(SPIKE, "scripts"));
  for (const name of readdirSync(SPIKE)) if (statSync(join(SPIKE, name)).isFile()) take(join(SPIKE, name));
  walk(join(ROOT, "app/server"));
  return out;
}

const LIST_START = /\[\s*(["'])(?:run|create)\1\s*,|\[\s*(["'])container\2\s*,\s*(["'])(?:run|create)\3\s*,/g;
// One shell line, with string joins (`"docker " + "run …"`) closed up.
const joined = (line) => line.replace(/["'`]\s*\+\s*["'`]/g, "");
const SHELL_RUN = /docker\s+(?:container\s+)?(?:run|create)\s/;
const PULL_NEVER = /(["'])--pull=never\1/;

// The docker run/create calls in one file's text, each with what the guard needs.
export function scanText(text) {
  const lists = [];
  for (const m of text.matchAll(LIST_START)) {
    let depth = 0;
    let end = m.index;
    for (; end < text.length; end++) {
      if (text[end] === "[") depth++;
      else if (text[end] === "]" && --depth === 0) break;
    }
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    lists.push({
      line: text.slice(0, m.index).split("\n").length,
      body: text.slice(m.index, end + 1),
      before: text.slice(lineStart, m.index),
      pullNever: PULL_NEVER.test(text.slice(m.index, end + 1)),
    });
  }
  const shells = [];
  text.split("\n").forEach((raw, i) => {
    if (/^\s*\/\//.test(raw)) return;
    const line = joined(raw);
    if (!SHELL_RUN.test(line)) return;
    shells.push({ line: i + 1, text: line, pullNever: /--pull[= ]never/.test(line) });
  });
  return { lists, shells };
}

test("the scan covers spike/lib, spike/packs, the top-level spike files, spike/scripts and app/server", () => {
  const files = sources().map((f) => relative(ROOT, f));
  for (const f of ["spike/lib/sandbox.mjs", "spike/packs/domains/labctl.mjs", "spike/agent-run.mjs", "spike/scripts/setup.mjs", "app/server/runs.mjs"]) {
    assert.ok(existsSync(join(ROOT, f)), `${f} exists`);
    assert.ok(files.includes(f), `${f} is scanned`);
  }
  assert.ok(!files.some((f) => f.endsWith(".test.mjs") || f.includes("node_modules")), "no tests, no installed code");
});

// One test per form the guard must see (L35b): each flagless form is found, and
// the same form with the flag passes.
for (const [form, bad, good] of [
  ["a docker run list", `docker(["run", "--rm", img]);`, `docker(["run", "--rm", "--pull=never", img]);`],
  ["a docker create list", `docker(["create", "--name", n, img]); docker(["start", n]);`, `docker(["create", "--pull=never", "--name", n, img]);`],
  ["a container run list", `docker(["container", "run", "--rm", img]);`, `docker(["container", "run", "--rm", "--pull=never", img]);`],
  ["a container create list", `docker(['container', 'create', img]);`, `docker(['container', 'create', '--pull=never', img]);`],
  ["a docker run line", "sh(`docker run --rm ${img} true`);", "sh(`docker run --rm --pull=never ${img} true`);"],
  ["a docker create line", "sh(`docker create ${img}`);", "sh(`docker create --pull=never ${img}`);"],
  ["a split docker run string", `sh("docker " + "run --rm " + img);`, `sh("docker " + "run --rm --pull=never " + img);`],
]) {
  test(`the guard sees ${form}`, () => {
    const b = scanText(bad);
    const found = [...b.lists, ...b.shells];
    assert.ok(found.length >= 1, `${form}: not found`);
    assert.ok(found.some((x) => !x.pullNever), `${form}: the flagless form reads as safe`);
    const g = scanText(good);
    assert.ok([...g.lists, ...g.shells].length >= 1 && [...g.lists, ...g.shells].every((x) => x.pullNever), `${form}: the flagged form is refused`);
  });
}

test("every docker run/create argument list carries --pull=never, or is a named exception", () => {
  const files = sources();
  assert.ok(files.length > 80, `only ${files.length} source files scanned`);
  const used = new Set();
  const missing = [];
  let seen = 0;
  for (const path of files) {
    const rel = relative(ROOT, path);
    for (const list of scanText(readFileSync(path, "utf8")).lists) {
      seen++;
      if (list.pullNever) continue;
      const ex = ARGV_EXCEPTIONS.find((e) => e.file === rel && (list.body.includes(e.marker) || list.before.includes(e.marker)));
      if (ex) { used.add(ex); continue; }
      missing.push(`${rel}:${list.line}`);
    }
  }
  assert.ok(seen >= 20, `only ${seen} docker run lists found: the scan is blind`);
  assert.deepEqual(missing, [], "docker run/create lists with no --pull=never (add the flag, or a named exception with a reason)");
  for (const e of ARGV_EXCEPTIONS) {
    assert.ok(used.has(e), `stale exception ${e.file} "${e.marker}": no flagless list matches it`);
    assert.ok(e.reason.length > 20, `${e.file}: an exception needs a reason`);
  }
});

test("every docker run/create written as shell text carries a pull-never flag, or is a named exception", () => {
  const used = new Set();
  const missing = [];
  for (const path of sources()) {
    const rel = relative(ROOT, path);
    for (const s of scanText(readFileSync(path, "utf8")).shells) {
      if (s.pullNever) continue;
      const ex = SHELL_EXCEPTIONS.find((e) => e.file === rel && s.text.includes(e.marker));
      if (ex) { used.add(ex); continue; }
      missing.push(`${rel}:${s.line}`);
    }
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
