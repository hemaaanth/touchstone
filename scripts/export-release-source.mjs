#!/usr/bin/env node
// Transfer the selected release input without Git history or excluded state blobs.
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sourceAllowed } from "./package-owner-release.mjs";

export function exportReleaseSource({ repo, revision, output }) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? "")) throw new Error("Use a full commit SHA.");
  repo = realpathSync(repo);
  if (!isAbsolute(output) || resolve(output) !== output) throw new Error("Use an absolute output file.");
  const parent = realpathSync(dirname(output));
  const stat = lstatSync(parent);
  if (parent !== dirname(output) || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw new Error("Output parent must be private and owned by this user.");
  const git = (...args) => execFileSync("git", ["--no-replace-objects", "-C", repo, ...args], {
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (git("rev-parse", `${revision}^{commit}`).toString().trim() !== revision) throw new Error("Revision must name a commit.");
  const objects = new Set([revision, git("rev-parse", `${revision}^{tree}`).toString().trim()]);
  let files = 0;
  for (const row of git("ls-tree", "-rzt", "--full-tree", revision).toString("utf8").split("\0").filter(Boolean)) {
    const tab = row.indexOf("\t");
    const [mode, type, object] = row.slice(0, tab).split(" ");
    const path = row.slice(tab + 1);
    if (type === "tree") objects.add(object);
    else if (sourceAllowed(path)) {
      if (type !== "blob" || !["100644", "100755"].includes(mode)) throw new Error("Release source must contain regular files only.");
      objects.add(object);
      files++;
    }
  }
  // No --revs: pack exactly these objects, without following commit parents.
  const pack = execFileSync("git", ["--no-replace-objects", "-C", repo, "pack-objects", "--stdout", "--no-reuse-delta"], {
    input: [...objects].join("\n") + "\n",
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    maxBuffer: 256 * 1024 * 1024,
  });
  writeFileSync(output, pack, { flag: "wx", mode: 0o600 });
  return { revision, files, objects: objects.size, bytes: pack.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { repo: { type: "string" }, revision: { type: "string" }, output: { type: "string" } } });
  console.log(JSON.stringify(exportReleaseSource(values)));
}
