import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { readFileSync, readdirSync, realpathSync, lstatSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { loadSnapshot, pinSnapshot } from "../../lib/proof-evidence.mjs";

// A snapshot holds small UTF-8 text files. Anything else is skipped and listed.
// A skipped file is a coverage gap. It is never silent and it never aborts the scan.
// A lockfile is the main input of the dependency checks and is often larger than
// a source file, so a project lockfile (not one under node_modules) may be up to
// lockfileBytes. This matches the 2 MiB single-file cap in lib/fetch.mjs.
export const LIMITS = { totalBytes: 8 * 1024 * 1024, fileBytes: 512 * 1024, lockfileBytes: 2 * 1024 * 1024, files: 20_000 };
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|gradle\.lockfile|packages\.lock\.json)$/;
export const fileCap = (file) => (LOCKFILE.test(file) && !/(^|\/)node_modules\//.test(file) ? LIMITS.lockfileBytes : LIMITS.fileBytes);
const RESERVED = /^(?:\.scanner-(?:db|rules)\/|\.scanner-sbom\.json$|\.semgrepignore$)/;
const inNodeModules = (file) => /(^|\/)node_modules\//.test(file);

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (root, args, opts = {}) => execFileSync("git", ["--no-replace-objects", "-C", root, ...args], { maxBuffer: 64 * 1024 * 1024, env, ...opts });
export const blobOid = (raw) => createHash("sha1").update(`blob ${raw.length}\0`).update(raw).digest("hex");

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

// Files git does not track. A git scan reads committed bytes only, so these are never read.
// Our own run files are not the operator's files.
const OURS = /^(?:\.touchstone\.json|snapshot\.json|supply-chain-[\w-]+\.json|\.scanner-(?:db|rules)\/.*|\.scanner-sbom\.json|\.semgrepignore)$/;
const topDir = (file) => file.match(/^(.*?node_modules)\//)?.[1] ?? (file.includes("/") ? file.split("/")[0] : "(root)");
const tally = (files) => {
  const byDir = {};
  for (const f of files) byDir[topDir(f)] = (byDir[topDir(f)] ?? 0) + 1;
  return { count: files.length, byDir: Object.fromEntries(Object.entries(byDir).sort((a, b) => b[1] - a[1]).slice(0, 15)), rootFiles: files.filter((f) => !f.includes("/")).slice(0, 10) };
};
function notRead(root) {
  const list = (args) => git(root, ["ls-files", "-z", "-o", ...args], { encoding: "utf8" }).split("\0").filter((f) => f && !OURS.test(f));
  return { untracked: tally(list(["--exclude-standard"])), ignored: tally(list(["-i", "--exclude-standard"])) };
}

// Counts for the record: why files were skipped, where, and which vendored packages lost code.
// A skipped file inside node_modules/<pkg> is a coverage gap: that package was not fully checked.
export function skipSummary(skipped) {
  const byReason = {}, byDir = {}, pkgs = new Map();
  for (const { file, reason } of skipped) {
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    byDir[topDir(file)] = (byDir[topDir(file)] ?? 0) + 1;
    const pkg = file.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1];
    if (pkg && (/\.[cm]?[jt]sx?$/.test(file) || /(?:^|\/)package\.json$/.test(file) || reason === "over-budget")) {
      const cur = pkgs.get(pkg) ?? { package: pkg, files: 0, reasons: new Set() };
      cur.files++; cur.reasons.add(reason); pkgs.set(pkg, cur);
    }
  }
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 15));
  return { count: skipped.length, byReason: sorted(byReason), byDir: sorted(byDir), vendoredGaps: { packages: pkgs.size, sample: [...pkgs.values()].slice(0, 20).map((p) => ({ ...p, reasons: [...p.reasons] })) } };
}

// opts.worktree reads a Git folder as a plain folder: untracked and ignored files too, current bytes, no commit pin.
export function captureSnapshot(source, { worktree = false } = {}) {
  const root = realpathSync(source);
  const isGit = !worktree && gitRoot(root);
  const commit = isGit ? git(root, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() : null;
  const entries = isGit
    ? git(root, ["ls-tree", "-rz", "--full-tree", commit], { encoding: "utf8" }).split("\0").filter(Boolean).map((e) => {
        const tab = e.indexOf("\t"), [mode, , oid] = e.slice(0, tab).split(" ");
        return { file: e.slice(tab + 1), regular: mode === "100644" || mode === "100755", oid };
      })
    : walk(root);
  const files = Object.create(null), skipped = [];
  let bytes = 0, count = 0;
  for (const { file, regular, oid } of entries.sort(order)) {
    const skip = (reason) => skipped.push({ file, reason });
    if (RESERVED.test(file)) { skip("reserved-name"); continue; }
    if (!regular) { skip("not-a-regular-file"); continue; }
    const abs = join(root, file);
    let raw = null;
    try {
      const rel = relative(root, realpathSync(abs));
      if (isAbsolute(rel) || rel.startsWith("..") || !lstatSync(abs).isFile()) { if (!isGit) { skip("path-escapes-source"); continue; } }
      else raw = readFileSync(abs);
    } catch { if (!isGit) { skip("unreadable"); continue; } }
    // Git mode pins the committed bytes. A dirty, moved or deleted working file never changes the evidence.
    if (isGit && (raw === null || blobOid(raw) !== oid)) {
      try { raw = git(root, ["cat-file", "blob", oid]); } catch { skip("unreadable"); continue; }
    }
    if (raw.length > fileCap(file)) { skip("too-large"); continue; }
    if (raw.includes(0) || !isUtf8(raw)) { skip("binary-or-not-utf8"); continue; }
    if (bytes + raw.length > LIMITS.totalBytes || count >= LIMITS.files) { skip("over-budget"); continue; }
    bytes += raw.length; count++;
    files[file] = raw.toString("utf8");
  }
  if (!count) throw new Error("Target has no scannable text files");
  const scope = isGit ? "committed-files-only" : worktree ? "worktree" : "folder";
  return { version: 1, scope, ...(commit ? { commit, notScanned: notRead(root) } : { folderHash: createHash("sha256").update(JSON.stringify(files)).digest("hex") }), files, skipped,
    npmAdvisories: readFileSync(new URL("./advisories/osv-scalibr/npm/all.zip", import.meta.url)).toString("base64") };
}

// ws holds the pin. source is what we read. A lab reads its own workspace.
export function prepareSnapshot(ws, source = ws, opts = {}) {
  try { return loadSnapshot(ws); }
  catch (err) {
    if (err.code !== "ENOENT" && !String(err.message).includes("Missing snapshot SHA-256 pin")) throw err;
    const snapshot = { ...captureSnapshot(source, opts), ...(opts.signingPolicy ? { signingPolicy: opts.signingPolicy } : {}) };
    const snapshotHash = pinSnapshot(ws, snapshot);
    return { snapshot, snapshotHash };
  }
}
