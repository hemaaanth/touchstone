import { execFileSync } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { loadSnapshot, pinSnapshot } from "../../lib/proof-evidence.mjs";

export function captureSnapshot(ws) {
  const git = (args) => execFileSync("git", ["--no-replace-objects", "-C", ws, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  if (realpathSync(ws) !== realpathSync(root)) throw new Error("Supply-chain target must be a standalone Git root");
  const commit = git(["rev-parse", "HEAD"]).trim();
  const files = Object.create(null);
  let bytes = 0;
  for (const entry of git(["ls-tree", "-rz", "--full-tree", commit]).split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t"), file = entry.slice(tab + 1), mode = entry.slice(0, 6);
    if (mode !== "100644" && mode !== "100755") throw new Error("Only regular source files are supported");
    const abs = join(ws, file), rel = relative(root, realpathSync(abs));
    if (isAbsolute(rel) || rel.startsWith("..") || !lstatSync(abs).isFile()) throw new Error("Source path escapes target");
    const raw = readFileSync(abs);
    bytes += raw.length;
    if (bytes > 8 * 1024 * 1024 || raw.length > 512 * 1024 || !isUtf8(raw) || raw.includes(0)) throw new Error("Target must contain at most 8 MiB of small UTF-8 text files");
    const content = raw.toString("utf8");
    if (content !== git(["show", `${commit}:${file}`])) throw new Error("Source differs from pinned commit");
    files[file] = content;
  }
  return { version: 1, commit, files, npmAdvisories: readFileSync(new URL("./advisories/osv-scalibr/npm/all.zip", import.meta.url)).toString("base64") };
}

export function prepareSnapshot(ws) {
  try { return loadSnapshot(ws); }
  catch (err) {
    if (err.code !== "ENOENT" && !String(err.message).includes("Missing snapshot SHA-256 pin")) throw err;
    const snapshot = captureSnapshot(ws);
    const snapshotHash = pinSnapshot(ws, snapshot);
    return { snapshot, snapshotHash };
  }
}
