#!/usr/bin/env node
// Source export only by default. --install is a separate, explicit network permission.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SHA = /^[a-f0-9]{40}$/;
const LIMIT = 256 * 1024 * 1024;
const digest = (data) => createHash("sha256").update(data).digest("hex");
const inside = (parent, child) => child === parent || child.startsWith(parent + sep);
const fail = (message) => { throw new Error(message); };
const exists = (path) => { try { lstatSync(path); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };

export function sourceAllowed(path) {
  const parts = path.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || /[\x00-\x1f\x7f\\]/.test(p))) fail("Unsafe source path.");
  if (!(["app", "spike", "lab", "tools", "scripts", "docs"].includes(parts[0]) || /^(?:LICENSE(?:\..*)?|NOTICE(?:\..*)?|THIRD_PARTY\.md|README\.md)$/.test(path))) return false;
  if (parts.some((p) => /^\.env/i.test(p) || /^(?:\.git|\.npmrc|\.netrc|\.bunfig\.toml|bunfig\.toml|node_modules|results|logs|tmp|cache|workspaces|\.cache|\.vite|dist|coverage)$/i.test(p))) return false;
  if (/^(?:spike|app)\/(?:data|state|cache)\//.test(path)) return false;
  if (parts.some((p) => /^(?:providers\.json|grants\.json|scopes\.json|spend\.json|daytona-pending\.json)$/.test(p) || /\.(?:env|pem|key|p12|pfx|sqlite(?:-wal|-shm)?|log|events|jsonl)$/.test(p))) return false;
  // These exact reviewed code modules are not runtime token files; other token-like paths stay excluded.
  if (parts.some((p) => /^console-token(?:\..*)?$/.test(p)) &&
      !["app/src/lib/console-token.ts", "spike/test/console-token.test.mjs"].includes(path)) return false;
  return true;
}

function absolutePath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path !== resolve(path) || path !== path.trim() || !/^\/[A-Za-z0-9_./-]+$/.test(path)) fail("Use a canonical absolute path without spaces or shell characters.");
  return path;
}

function noLinks(path) {
  let at = sep;
  for (const part of path.split(sep).filter(Boolean)) {
    at = join(at, part);
    if (lstatSync(at).isSymbolicLink()) fail("Symlink paths are not allowed.");
  }
}

function destination(path, repo) {
  absolutePath(path);
  if (exists(path)) fail("Destination already exists; nothing was overwritten.");
  const parent = dirname(path);
  noLinks(parent);
  const st = lstatSync(parent);
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o022)) fail("Destination parent must be owned by this user and not group/world writable.");
  if (inside(repo, path) || inside(path, repo)) fail("Destination overlaps the source checkout.");
  for (let at = parent; at !== dirname(at); at = dirname(at)) {
    const marker = join(at, ".git");
    if (exists(marker) && (!lstatSync(marker).isDirectory() || exists(join(marker, "HEAD")))) fail("Destination must be outside every Git checkout.");
  }
}

export function runtimeEnvironment(state, port = 5190) {
  absolutePath(state);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 5188) fail("Use a separate unprivileged port, never 5188.");
  return {
    HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "production",
    HOME: join(state, "home"), TMPDIR: join(state, "tmp"), TMP: join(state, "tmp"), TEMP: join(state, "tmp"), STRIX_TMPDIR: join(state, "tmp"),
    XDG_CACHE_HOME: join(state, "cache"), XDG_CONFIG_HOME: join(state, "config"), XDG_DATA_HOME: join(state, "share"), XDG_STATE_HOME: join(state, "state"),
    TOUCHSTONE_VITE_CACHE_DIR: join(state, "cache/vite"), CBM_CACHE_DIR: join(state, "cache/cbm"), PI_CBM_CACHE_DIR: join(state, "cache/cbm"),
    BUN_INSTALL_CACHE_DIR: join(state, "cache/bun"), npm_config_cache: join(state, "cache/npm"),
    TOUCHSTONE_RESULTS_DIR: join(state, "results"), AGENT_RESULTS_DIR: join(state, "results"),
    SPEND_LEDGER: join(state, "spend.json"), DAYTONA_PENDING: join(state, "daytona-pending.json"),
    TOUCHSTONE_PROVIDERS_FILE: join(state, "providers.json"), TOUCHSTONE_SCOPES_FILE: join(state, "scopes.json"),
    TOUCHSTONE_GRANTS_FILE: join(state, "grants.json"), TOUCHSTONE_GRANT_TOKEN_FILE: join(state, "console-token"),
  };
}

export function runCommand(command, args, options) {
  try {
    return execFileSync(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"], maxBuffer: LIMIT, timeout: 20 * 60_000 });
  } catch { fail("A packaging command failed. No release was completed; command output is withheld."); }
}

function sealTree(directory, root = directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      if (!inside(root, realpathSync(path))) fail("Dependency link leaves its package directory.");
    } else if (st.isDirectory()) sealTree(path, root);
    else if (st.isFile()) {
      if (st.nlink !== 1) fail("Shared hardlinks are not allowed in a release.");
      chmodSync(path, st.mode & 0o111 ? 0o500 : 0o400);
    } else fail("Special files are not allowed in a release.");
  }
  chmodSync(directory, 0o500);
}

export function packageRelease({ repo, revision, output, state, node, bun, port = 5190, install = false }, { run = runCommand } = {}) {
  if (typeof revision !== "string" || revision.length !== 40 || !SHA.test(revision)) fail("Provide the full reviewed 40-character Git commit SHA.");
  repo = realpathSync(repo);
  node = absolutePath(node);
  bun = absolutePath(bun);
  noLinks(node); noLinks(bun);
  if (![node, bun].every((p) => lstatSync(p).isFile() && (lstatSync(p).mode & 0o111))) fail("Node and Bun must be executable files.");
  destination(output, repo); destination(state, repo);
  if (basename(output) !== revision) fail("The release directory name must equal the full Git SHA.");
  if (inside(output, state) || inside(state, output)) fail("State and release directories must not overlap.");
  const env = runtimeEnvironment(state, port);
  const clean = { PATH: `${dirname(node)}:${dirname(bun)}:/usr/bin:/bin`, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args) => run("git", ["--no-replace-objects", "-C", repo, ...args], { env: clean });
  if (git("rev-parse", "--show-toplevel").toString().trim() !== repo || git("rev-parse", `${revision}^{commit}`).toString().trim() !== revision) fail("The source must be a Git root and revision must name a commit, not a tag.");
  const entries = git("ls-tree", "-rz", "--full-tree", revision).toString("utf8").split("\0").filter(Boolean).map((line) => {
    const [header, ...name] = line.split("\t");
    const [mode, type, object] = header.split(" ");
    return { path: name.join("\t"), mode, type, object };
  }).filter((entry) => sourceAllowed(entry.path));
  if (entries.some((e) => !["100644", "100755"].includes(e.mode) || e.type !== "blob" || !SHA.test(e.object))) fail("Source symlinks and submodules are refused; vendor reviewed regular files instead.");
  for (const required of ["app/package.json", "app/bun.lock", "app/server/start.mjs", "spike/package.json", "spike/package-lock.json", "spike/agent-run.mjs", "scripts/touchstone-owner.service"]) {
    if (!entries.some((e) => e.path === required)) fail(`Reviewed revision is missing ${required}.`);
  }
  if (!entries.some((e) => e.path.startsWith("lab/"))) fail("Reviewed revision is missing the lab assets.");
  // Read only the selected Git blobs, never working-tree files or excluded stores.
  const batch = run("git", ["--no-replace-objects", "-C", repo, "cat-file", "--batch"], { env: clean, input: entries.map((e) => e.object).join("\n") + "\n" });
  let at = 0;
  for (const entry of entries) {
    const end = batch.indexOf(10, at);
    const [object, type, size] = batch.subarray(at, end).toString().split(" ");
    const length = Number(size);
    if (end < at || object !== entry.object || type !== "blob" || !Number.isSafeInteger(length) || length < 0 || end + 1 + length >= batch.length) fail("Invalid Git blob response.");
    entry.data = batch.subarray(end + 1, end + 1 + length);
    at = end + 2 + length;
  }
  const versions = {};
  for (const [name, command] of [["node", node], ["bun", bun]]) {
    const version = run(command, ["--version"], { env: clean }).toString().trim();
    if (!/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) fail("Unrecognized runtime version.");
    if (name === "node" && Number(version.replace(/^v/, "").split(".")[0]) < 24) fail("Node 24 or newer is required for the worker runtime.");
    versions[name] = { path: command, version };
  }
  // Exclusive creation, no overwrite, no automatic rollback of caller-owned paths.
  mkdirSync(output, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  for (const dir of ["env", "logs", "tmp", "home", "cache", "config", "share", "state", "results", "cache/vite", "cache/cbm", "cache/bun", "cache/npm"]) mkdirSync(join(state, dir), { recursive: true, mode: 0o700 });
  const runtimeEnv = { ...env, PATH: clean.PATH };
  writeFileSync(join(state, "env/owner.env"), Object.entries(runtimeEnv).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  for (const entry of entries) {
    const path = join(output, entry.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, entry.data, { flag: "wx", mode: entry.mode === "100755" ? 0o700 : 0o600 });
  }
  if (install) {
    for (const project of ["spike", "app"]) run(bun, ["install", "--frozen-lockfile", "--ignore-scripts", "--no-env-file", "--backend=copyfile", "--no-progress"], { cwd: join(output, project), env: { ...runtimeEnv, NODE_ENV: "development" } });
    for (const path of ["app/node_modules/vite/package.json", "spike/node_modules/@earendil-works/pi-durable/package.json"]) if (!exists(join(output, path))) fail("Private dependency installation is incomplete.");
  }
  // Frozen installs must not alter tracked sources, including either lockfile.
  for (const entry of entries) {
    const path = join(output, entry.path);
    noLinks(path);
    if (!lstatSync(path).isFile() || lstatSync(path).nlink !== 1) fail("Installation replaced a reviewed source file.");
    if (digest(readFileSync(path)) !== digest(entry.data)) fail("Installation changed reviewed source or a frozen lockfile.");
  }
  const user = userInfo().username;
  if (!/^[a-z_][a-z0-9_-]*[$]?$/.test(user)) fail("Unsupported service account name.");
  const template = entries.find((e) => e.path === "scripts/touchstone-owner.service").data.toString();
  const service = template.replaceAll("@RELEASE@", output).replaceAll("@STATE@", state).replaceAll("@NODE@", node).replaceAll("@USER@", user);
  writeFileSync(join(output, "touchstone-owner.service"), service, { flag: "wx", mode: 0o600 });
  const manifest = { version: 1, revision, release: output, state, dependencies: install ? "installed" : "not-installed", runtimes: versions,
    files: entries.map(({ path, mode, data }) => ({ path, mode, bytes: data.length, sha256: digest(data) })), serviceSha256: digest(service) };
  const text = JSON.stringify(manifest, null, 2) + "\n";
  // Seal first. A failed preparation has no completed release manifest.
  sealTree(output);
  chmodSync(output, 0o700);
  try {
    writeFileSync(join(output, "release-manifest.json"), text, { flag: "wx", mode: 0o400 });
    writeFileSync(join(output, "release-manifest.sha256"), `${digest(text)}  release-manifest.json\n`, { flag: "wx", mode: 0o400 });
  } finally { chmodSync(output, 0o500); }
  return { revision, output, state, manifestSha256: digest(text), dependencies: manifest.dependencies };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { repo: { type: "string" }, revision: { type: "string" }, output: { type: "string" }, state: { type: "string" }, node: { type: "string" }, bun: { type: "string" }, port: { type: "string" }, install: { type: "boolean", default: false } }, strict: true });
    console.log(JSON.stringify(packageRelease({ ...values, port: values.port === undefined ? 5190 : Number(values.port) })));
  } catch (e) { console.error(`Owner release refused: ${e.message}`); process.exitCode = 1; }
}
