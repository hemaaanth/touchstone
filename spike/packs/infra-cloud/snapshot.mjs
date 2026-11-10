import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { isUtf8 } from "node:buffer";
import { execFileSync } from "node:child_process";
import { loadSnapshot, pinSnapshot } from "../../lib/proof-evidence.mjs";

export function captureSnapshot(ws) {
  const files = Object.create(null);
  let total = 0;
  function walk(rel = "") {
    for (const entry of readdirSync(join(ws, rel), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || ["node_modules", "oracle", "out", "cache", "snapshot.json", "infra-cloud-leads.json"].includes(entry.name)) continue;
      const file = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("IaC snapshots refuse symlinks");
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const bytes = readFileSync(join(ws, file));
        total += bytes.length;
        if (bytes.length > 512 * 1024 || total > 8 * 1024 * 1024 || !isUtf8(bytes) || bytes.includes(0)) throw new Error("IaC snapshot exceeds the small UTF-8 source limit");
        files[file] = bytes.toString("utf8");
      }
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
    git(["-c", "user.name=Touchstone lab", "-c", "user.email=lab@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Pin IaC snapshot"]);
    commit = git(["rev-parse", "HEAD"]).trim();
  } finally { rmSync(repo, { recursive: true, force: true }); }
  return { version: 1, commit, files };
}

export function prepareSnapshot(ws) {
  const cfg = JSON.parse(readFileSync(join(ws, ".touchstone.json"), "utf8"));
  if (cfg.evidenceSnapshot || cfg.snapshotHash) return loadSnapshot(ws);
  const snapshot = captureSnapshot(ws);
  return { snapshot, snapshotHash: pinSnapshot(ws, snapshot) };
}

export function makeLabWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "touchstone-infra-"));
  cpSync(new URL("./lab/", import.meta.url), ws, { recursive: true });
  return ws;
}
