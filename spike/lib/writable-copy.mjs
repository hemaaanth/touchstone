import { chmodSync, cpSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Sealed releases are read-only; disposable copies must support edits and cleanup.
function ownerWritable(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory() && !stat.isFile()) return;
  if (!(stat.mode & 0o200)) chmodSync(path, stat.mode | 0o200);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) ownerWritable(join(path, name));
  }
}

export function copyWritable(source, destination, options) {
  cpSync(source, destination, options);
  ownerWritable(destination);
}
