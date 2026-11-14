import { copyWritable } from "../../lib/writable-copy.mjs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { isUtf8 } from "node:buffer";
import { execFileSync } from "node:child_process";
import { loadSnapshot, pinSnapshot } from "../../lib/proof-evidence.mjs";

// A real repository carries binaries, symlinks and large files. The snapshot
// keeps every small UTF-8 source file and lists the rest as coverage gaps.
export function captureSnapshot(ws) {
  const files = Object.create(null), skipped = [];
  let total = 0;
  function walk(rel = "") {
    for (const entry of readdirSync(join(ws, rel), { withFileTypes: true })) {
      const file = rel ? `${rel}/${entry.name}` : entry.name;
      // Everything skipped is recorded, so a vanished `.github` or a folder
      // named `out` shows up as a gap instead of disappearing silently.
      if (entry.name.startsWith(".")) { skipped.push({ file, reason: "dot name" }); continue; }
      if (["node_modules", "oracle", "out", "cache", "snapshot.json", "infra-cloud-leads.json"].includes(entry.name)) { skipped.push({ file, reason: "generated or shared scratch" }); continue; }
      if (entry.isSymbolicLink()) { skipped.push({ file, reason: "symlink" }); continue; }
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.isFile()) { skipped.push({ file, reason: "not a regular file" }); continue; }
      const bytes = readFileSync(join(ws, file));
      if (!isUtf8(bytes) || bytes.includes(0)) { skipped.push({ file, reason: "not UTF-8 text" }); continue; }
      if (bytes.length > 512 * 1024) { skipped.push({ file, reason: "larger than 512 KiB" }); continue; }
      if (total + bytes.length > 8 * 1024 * 1024) { skipped.push({ file, reason: "snapshot total above 8 MiB" }); continue; }
      total += bytes.length;
      files[file] = bytes.toString("utf8");
    }
  }
  walk();
  // This private commit cites the exact captured bytes, not an upstream deployment.
  const repo = mkdtempSync(join(tmpdir(), "infra-snapshot-git-"));
  let commit;
  try {
    for (const [file, source] of Object.entries(files)) { mkdirSync(dirname(join(repo, file)), { recursive: true }); writeFileSync(join(repo, file), source); }
    const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" } });
    git(["init", "--quiet"]);
    git(["add", "--", ...Object.keys(files)]);
    git(["-c", "user.name=Touchstone lab", "-c", "user.email=lab@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Pin IaC snapshot"]);
    commit = git(["rev-parse", "HEAD"]).trim();
  } finally { rmSync(repo, { recursive: true, force: true }); }
  return { version: 1, commit, files, ...(skipped.length ? { skipped } : {}) };
}

// A real folder may carry no config. Nothing is pinned yet, so capture it.
function config(ws) {
  try { return JSON.parse(readFileSync(join(ws, ".touchstone.json"), "utf8")); } catch (err) { if (err.code === "ENOENT") return {}; throw err; }
}

export function prepareSnapshot(ws) {
  const cfg = config(ws);
  if (cfg.evidenceSnapshot || cfg.snapshotHash) return loadSnapshot(ws);
  const snapshot = captureSnapshot(ws);
  return { snapshot, snapshotHash: pinSnapshot(ws, snapshot) };
}

export function makeLabWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "touchstone-infra-"));
  copyWritable(new URL("./lab/", import.meta.url), ws, { recursive: true });
  return ws;
}
