// Skip a test when Docker or an image it needs is missing, with a reason.
// A missing daemon used to surface as `spawnSync docker ENOENT` or a failed
// assertion. Callers pass the return value as node:test's `skip` option:
// false runs the test, a string skips it and prints the reason.
import { execFileSync } from "node:child_process";

function dockerOk() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

function imageOk(image) {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

export function skipUnlessDocker() {
  return dockerOk() ? false : "docker is not available (spike/scripts/setup-docker)";
}

export function skipUnlessImages(...images) {
  if (!dockerOk()) return "docker is not available (spike/scripts/setup-docker)";
  for (const image of images) {
    if (!imageOk(image)) return `image not present: ${image} (spike/scripts/setup-docker)`;
  }
  return false;
}
