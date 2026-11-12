import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { readFileSync, readdirSync, realpathSync, lstatSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { loadSnapshot, pinSnapshot } from "../../lib/proof-evidence.mjs";

// A snapshot holds small UTF-8 text files. Anything else is skipped and listed.
// A skipped file is a coverage gap. It is never silent and it never aborts the scan.
export const LIMITS = { totalBytes: 8 * 1024 * 1024, fileBytes: 512 * 1024, files: 20_000 };
const RESERVED = /^(?:\.scanner-(?:db|rules)\/|\.scanner-sbom\.json$|\.semgrepignore$)/;
const inNodeModules = (file) => /(^|\/)node_modules\//.test(file);

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (root, args, opts = {}) => execFileSync("git", ["--no-replace-objects", "-C", root, ...args], { maxBuffer: 64 * 1024 * 1024, env, ...opts });
const blobOid = (raw) => createHash("sha1").update(`blob ${raw.length}\0`).update(raw).digest("hex");

function gitRoot(dir) {
  try { return realpathSync(git(dir, ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) === realpathSync(dir); }
  catch { return false; }
}

// Walk a folder. Never follows symlinks. Never reads .git.
function walk(root, dir = root, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const abs = join(dir, e.name), rel = relative(root, abs).split("\\").join("/");
    if (e.isDirectory()) walk(root, abs, out);
    else out.push({ file: rel, regular: e.isFile() });
  }
  return out;
}

// Source files first, vendored code last, so the byte budget never starves the project's own files.
const order = (a, b) => inNodeModules(a.file) - inNodeModules(b.file) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

export function captureSnapshot(source) {
  const root = realpathSync(source);
  const isGit = gitRoot(root);
  const commit = isGit ? git(root, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() : null;
  const entries = isGit
    ? git(root, ["ls-tree", "-rz", "--full-tree", commit], { encoding: "utf8" }).split("\0").filter(Boolean).map((e) => {
        const tab = e.indexOf("\t"), [mode, , oid] = e.slice(0, tab).split(" ");
        return { file: e.slice(tab + 1), regular: mode === "100644" || mode === "100755", oid };
      })
    : walk(root);
  const files = Object.create(null), skipped = [];
  let bytes = 0;
  for (const { file, regular, oid } of entries.sort(order)) {
    const skip = (reason) => skipped.push({ file, reason });
    if (RESERVED.test(file)) { skip("reserved-name"); continue; }
    if (!regular) { skip("not-a-regular-file"); continue; }
    const abs = join(root, file);
    let raw;
    try {
      const rel = relative(root, realpathSync(abs));
      if (isAbsolute(rel) || rel.startsWith("..") || !lstatSync(abs).isFile()) { skip("path-escapes-source"); continue; }
      raw = readFileSync(abs);
      // Git mode pins the committed bytes. A dirty working tree never changes the evidence.
      if (isGit && blobOid(raw) !== oid) raw = git(root, ["cat-file", "blob", oid]);
    } catch { skip("unreadable"); continue; }
    if (raw.length > LIMITS.fileBytes) { skip("too-large"); continue; }
    if (raw.includes(0) || !isUtf8(raw)) { skip("binary-or-not-utf8"); continue; }
    if (bytes + raw.length > LIMITS.totalBytes || Object.keys(files).length >= LIMITS.files) { skip("over-budget"); continue; }
    bytes += raw.length;
    files[file] = raw.toString("utf8");
  }
  if (!Object.keys(files).length) throw new Error("Target has no scannable text files");
  return { version: 1, ...(commit ? { commit } : { folderHash: createHash("sha256").update(JSON.stringify(files)).digest("hex") }), files, skipped,
    npmAdvisories: readFileSync(new URL("./advisories/osv-scalibr/npm/all.zip", import.meta.url)).toString("base64") };
}

// ws holds the pin. source is what we read. A lab reads its own workspace.
export function prepareSnapshot(ws, source = ws) {
  try { return loadSnapshot(ws); }
  catch (err) {
    if (err.code !== "ENOENT" && !String(err.message).includes("Missing snapshot SHA-256 pin")) throw err;
    const snapshot = captureSnapshot(source);
    const snapshotHash = pinSnapshot(ws, snapshot);
    return { snapshot, snapshotHash };
  }
}
