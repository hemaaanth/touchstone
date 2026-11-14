import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageRelease, runCommand, runtimeEnvironment, sourceAllowed } from "../package-owner-release.mjs";

const template = readFileSync(new URL("../touchstone-owner.service", import.meta.url), "utf8");
const tokenSourcePaths = ["app/src/lib/console-token.ts", "spike/test/console-token.test.mjs"];
const excludedFixturePaths = [
  "spike/.env.local", "spike/data/providers.json", "spike/data/scopes.json", "spike/data/grants.json", "spike/data/console-token",
  "spike/spend.json", "spike/results/agent/old.json", "app/node_modules/old.js", "app/.npmrc",
  "app/console-token", "app/console-token.json", "app/src/lib/console-token", "app/src/lib/console-token.json",
  "app/src/lib/console-token.ts.env", "app/src/lib/console-token.ts.bak", "app/src/other/console-token.ts",
  "app/data/console-token.ts", "spike/data/console-token.test.mjs", "spike/test/console-token.test.mjs.bak",
  "spike/test/console-token", "spike/test/console-token.json", "app/src/lib/.env", "app/src/lib/secret.key",
];
const hash = (data) => createHash("sha256").update(data).digest("hex");
const put = (path, data = "fixture") => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
function writable(dir) {
  chmodSync(dir, 0o700);
  for (const item of readdirSync(dir)) {
    const path = join(dir, item), st = lstatSync(path);
    if (st.isDirectory()) writable(path);
    else if (!st.isSymbolicLink()) chmodSync(path, 0o600);
  }
}
function fixture(fn) {
  // Keep fixtures outside any checkout and remove only this owned directory.
  const root = mkdtempSync("/tmp/owner-package-test-");
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  try {
    git("init", "-q");
    for (const path of ["app/package.json", "app/bun.lock", "app/server/start.mjs", "spike/package.json", "spike/package-lock.json", "spike/agent-run.mjs", "lab/vault/src/Test.sol"]) put(join(repo, path), `tracked ${path}`);
    for (const path of tokenSourcePaths) put(join(repo, path), `export const fixture = ${JSON.stringify(path)};`);
    put(join(repo, "scripts/touchstone-owner.service"), template);
    for (const path of excludedFixturePaths) put(join(repo, path), `FAKE_EXCLUDED_${path}`);
    git("add", "."); git("commit", "-qm", "fixture");
    const revision = git("rev-parse", "HEAD");
    const calls = [];
    const options = { repo, revision, output: join(root, revision), state: join(root, "state"), node: join(root, "bin/node"), bun: join(root, "bin/bun") };
    for (const path of [options.node, options.bun]) { put(path, "do not execute this stub"); chmodSync(path, 0o700); }
    const run = (command, args, opts) => {
      calls.push({ command, args, opts });
      if (command === "git") return runCommand(command, args, opts);
      if (args[0] === "--version") return Buffer.from(command === options.node ? "v24.10.0\n" : "1.3.0\n");
      assert.equal(command, options.bun);
      assert.deepEqual(args, ["install", "--frozen-lockfile", "--ignore-scripts", "--no-env-file", "--backend=copyfile", "--no-progress"]);
      assert.equal(opts.env.HOME, join(options.state, "home"));
      assert.equal(opts.env.NODE_OPTIONS, undefined);
      assert.equal(opts.env.DAYTONA_API_KEY, undefined);
      assert.equal(opts.env.NODE_ENV, "development");
      if (opts.cwd.endsWith("/app")) {
        put(join(opts.cwd, "node_modules/vite/package.json"), "{}");
        put(join(opts.cwd, "node_modules/vite/bin/vite.js"), "stub");
        mkdirSync(join(opts.cwd, "node_modules/.bin"));
        symlinkSync("../vite/bin/vite.js", join(opts.cwd, "node_modules/.bin/vite"));
      } else put(join(opts.cwd, "node_modules/@earendil-works/pi-durable/package.json"), "{}");
      return Buffer.from("");
    };
    fn({ root, repo, git, options, run, calls });
  } finally { writable(root); rmSync(root, { recursive: true, force: true }); }
}

test("exports selected commit blobs only, with manifest hash and no mutable checkout content", () => fixture(({ repo, git, options, run, calls }) => {
  put(join(repo, "app/server/start.mjs"), "dirty edit must not ship");
  put(join(repo, "app/untracked.js"), "untracked must not ship");
  const result = packageRelease(options, { run });
  assert.equal(readFileSync(join(options.output, "app/server/start.mjs"), "utf8"), "tracked app/server/start.mjs");
  assert.equal(existsSync(join(options.output, "app/untracked.js")), false);
  for (const path of excludedFixturePaths) {
    assert.equal(existsSync(join(options.output, path)), false);
    const object = git("rev-parse", `${options.revision}:${path}`);
    assert.ok(!calls.find((c) => c.args.includes("cat-file")).opts.input.includes(object));
  }
  assert.equal(calls.filter((c) => c.command !== "git" && c.args[0] !== "--version").length, 0);
  const text = readFileSync(join(options.output, "release-manifest.json"), "utf8");
  const manifest = JSON.parse(text);
  assert.equal(result.manifestSha256, hash(text));
  assert.equal(readFileSync(join(options.output, "release-manifest.sha256"), "utf8"), `${hash(text)}  release-manifest.json\n`);
  assert.equal(manifest.revision, options.revision);
  assert.equal(manifest.dependencies, "not-installed");
  assert.equal(manifest.runtimes.node.version, "v24.10.0");
  for (const f of manifest.files) assert.equal(f.sha256, hash(readFileSync(join(options.output, f.path))));
  assert.equal(lstatSync(options.output).mode & 0o777, 0o500);
  assert.equal(lstatSync(join(options.output, "spike/agent-run.mjs")).mode & 0o777, 0o400);
  assert.equal(existsSync(join(options.output, ".git")), false);
}));

test("exports reviewed token source modules without reading token files or secret lookalikes", () => fixture(({ options, run, calls, git }) => {
  packageRelease(options, { run });
  const manifest = JSON.parse(readFileSync(join(options.output, "release-manifest.json"), "utf8"));
  const batch = calls.find((c) => c.args.includes("cat-file")).opts.input.split("\n");
  for (const path of tokenSourcePaths) {
    assert.equal(readFileSync(join(options.output, path), "utf8"), `export const fixture = ${JSON.stringify(path)};`);
    assert.ok(manifest.files.some((file) => file.path === path), path);
    assert.ok(batch.includes(git("rev-parse", `${options.revision}:${path}`)), path);
  }
  for (const path of excludedFixturePaths) {
    assert.equal(existsSync(join(options.output, path)), false, path);
    assert.ok(!manifest.files.some((file) => file.path === path), path);
    assert.ok(!batch.includes(git("rev-parse", `${options.revision}:${path}`)), path);
  }
}));

test("exports tracked app trees and spike modules using an independent Git inventory", () => fixture(({ root, options, run, calls }) => {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const git = (...args) => execFileSync("git", ["--no-replace-objects", "-C", repo, ...args], {
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).toString();
  const revision = git("rev-parse", "HEAD").trim();
  // Do not derive expected files from sourceAllowed or the manifest: both omit the same missing imports.
  // Inventory app trees and imported spike code without running it. Packs also contain excluded TLS lab keys.
  const sources = git("ls-tree", "-rz", "--full-tree", revision, "--",
    "app/src", "app/server", "app/public", "app/index.html", "app/vite.config.ts", "spike/lib", "spike/packs", "spike/agent-run.mjs",
  ).split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    return { path: line.slice(tab + 1), object: line.slice(0, tab).split(" ")[2] };
  }).filter(({ path }) => !path.startsWith("spike/packs/") || /\.(?:[cm]?[jt]sx?)$/.test(path));
  assert.ok(sources.some((file) => file.path === "app/src/App.tsx"));
  assert.ok(sources.some((file) => file.path === "app/src/lib/console-token.ts"));
  const output = join(root, revision);
  packageRelease({ ...options, repo: repo.replace(/\/$/, ""), revision, output }, { run });
  assert.ok(!calls.some((call) => call.args[0] === "install"));
  const manifest = JSON.parse(readFileSync(join(output, "release-manifest.json"), "utf8"));
  for (const { path, object } of sources) {
    assert.ok(existsSync(join(output, path)), `Missing tracked runtime source: ${path}`);
    const data = readFileSync(join(output, path));
    assert.equal(createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex"), object, path);
    assert.ok(manifest.files.some((file) => file.path === path && file.sha256 === hash(data)), path);
  }
}));

test("private state covers ledger, workspaces, logs, caches and stores; service never auto-starts", () => fixture(({ options, run }) => {
  packageRelease(options, { run });
  const env = readFileSync(join(options.state, "env/owner.env"), "utf8");
  for (const [key, value] of Object.entries(runtimeEnvironment(options.state))) assert.ok(env.includes(`${key}=${value}\n`));
  for (const key of ["SPEND_LEDGER", "TMPDIR", "STRIX_TMPDIR", "HOME", "TOUCHSTONE_RESULTS_DIR", "AGENT_RESULTS_DIR", "XDG_CACHE_HOME", "TOUCHSTONE_VITE_CACHE_DIR", "CBM_CACHE_DIR", "DAYTONA_PENDING", "TOUCHSTONE_PROVIDERS_FILE", "TOUCHSTONE_GRANT_TOKEN_FILE"]) assert.ok(runtimeEnvironment(options.state)[key].startsWith(options.state + "/"));
  for (const name of ["providers.json", "scopes.json", "grants.json", "console-token", "spend.json"]) assert.equal(existsSync(join(options.state, name)), false);
  assert.equal(lstatSync(options.state).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(options.state, "env/owner.env")).mode & 0o777, 0o600);
  const service = readFileSync(join(options.output, "touchstone-owner.service"), "utf8");
  assert.ok(service.includes(`ExecStart=${options.node} ${options.output}/app/server/start.mjs`));
  assert.ok(service.includes(`ReadOnlyPaths=${options.output}`));
  assert.ok(service.includes(`StandardOutput=append:${options.state}/logs/server.log`));
  assert.ok(service.includes("Restart=no"));
  assert.ok(service.includes("PrivateTmp=true"));
  assert.ok(!service.includes("@RELEASE@"));
}));

test("explicit installs use private frozen copies only and preserve both source locks", () => fixture(({ options, run, calls }) => {
  const result = packageRelease({ ...options, install: true }, { run });
  assert.equal(result.dependencies, "installed");
  assert.equal(calls.filter((c) => c.args[0] === "install").length, 2);
  assert.ok(lstatSync(join(options.output, "app/node_modules")).isDirectory());
  assert.ok(lstatSync(join(options.output, "app/node_modules/.bin/vite")).isSymbolicLink());
  assert.ok(!calls.some((c) => c.args.some((a) => /setup\.mjs|docker|systemctl|build|start\.mjs/.test(a))));
}));

test("refuses existing output or state, wrong SHA, checkout destinations and symlink parents", () => {
  for (const kind of ["output", "state", "short", "branch", "newline", "wrong-name", "checkout", "symlink", "overlap", "port", "path-newline", "shared-parent"]) fixture(({ root, repo, options, run }) => {
    const altered = { ...options };
    if (kind === "output" || kind === "state") mkdirSync(altered[kind]);
    if (kind === "short") altered.revision = options.revision.slice(0, 7);
    if (kind === "branch") altered.revision = "main";
    if (kind === "newline") altered.revision += "\n";
    if (kind === "wrong-name") altered.output = join(root, "current");
    if (kind === "checkout") altered.output = join(repo, options.revision);
    if (kind === "symlink") { symlinkSync(root, join(root, "link")); altered.output = join(root, "link", options.revision); }
    if (kind === "overlap") altered.state = altered.output;
    if (kind === "port") altered.port = 5188;
    if (kind === "path-newline") altered.state += "\n";
    if (kind === "shared-parent") chmodSync(root, 0o777);
    assert.throws(() => packageRelease(altered, { run }));
    assert.equal(existsSync(join(altered.output, "release-manifest.json")), false);
  });
});

test("refuses tracked source links and missing launcher before making destinations", () => {
  for (const kind of ["link", "missing"]) fixture(({ repo, git, options, run }) => {
    if (kind === "link") symlinkSync("/etc/passwd", join(repo, "app/escape"));
    else rmSync(join(repo, "app/server/start.mjs"));
    git("add", "."); git("commit", "-qm", "invalid tree");
    const revision = git("rev-parse", "HEAD");
    const output = join(dirname(options.output), revision);
    assert.throws(() => packageRelease({ ...options, revision, output }, { run }));
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(options.state), false);
  });
});

test("failed install or changed lock has no completed manifest; external dependency links refuse", () => {
  for (const kind of ["failure", "lock", "external", "hardlink"]) fixture(({ root, options, run }) => {
    const stub = (command, args, opts) => {
      if (args[0] === "install" && kind === "failure") throw new Error("stub install failure");
      const result = run(command, args, opts);
      if (args[0] === "install" && opts.cwd.endsWith("/app")) {
        if (kind === "lock") writeFileSync(join(opts.cwd, "bun.lock"), "changed");
        if (kind === "external") symlinkSync(root, join(opts.cwd, "node_modules/shared"));
        if (kind === "hardlink") { put(join(root, "shared-module")); linkSync(join(root, "shared-module"), join(opts.cwd, "node_modules/shared")); }
      }
      return result;
    };
    assert.throws(() => packageRelease({ ...options, install: true }, { run: stub }));
    assert.equal(existsSync(join(options.output, "release-manifest.json")), false);
  });
});

test("path filter refuses traversal and excludes dotenv variants and runtime files", () => {
  for (const path of ["app/../secret", "/app/start.mjs", "app/a\nb", "app/a\\b"]) assert.throws(() => sourceAllowed(path));
  for (const path of ["app/.env", "app/.env.production", "spike/.env.local", "spike/data/x.json", "spike/results/x", "app/node_modules/x", "lab/key.pem", "app/logs/x", "app/cache/x"]) assert.equal(sourceAllowed(path), false);
  for (const path of [...excludedFixturePaths, "app/src/lib/console-token.ts/nested.ts", "spike/test/console-token.test.mjs/nested.mjs"]) assert.equal(sourceAllowed(path), false, path);
  for (const path of [...tokenSourcePaths, "app/vite.config.ts", "spike/lib/sandbox.mjs", "lab/vault/src/Contract.sol", "tools/fetch-cbm-bin.sh"]) assert.equal(sourceAllowed(path), true, path);
});
