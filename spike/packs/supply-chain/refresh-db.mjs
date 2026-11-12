// Operator step. Downloads the grype vulnerability database into the cache.
// This is the only network step in the pack. A scan never downloads.
// It is not part of a run, and it runs a tool in Docker like every other step.
// Usage: node packs/supply-chain/refresh-db.mjs
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runTool } from "../../lib/wrap.mjs";
import { SCANNERS, grypeDbDir, grypeDbReady } from "./scanners.mjs";

const dir = grypeDbDir();
mkdirSync(join(dir, "tmp"), { recursive: true });
const r = await runTool({
  image: SCANNERS.grype.image, ws: dir, network: "bridge", timeoutMs: 1_800_000,
  cmd: ["db", "update"],
  env: { HOME: "/work", TMPDIR: "/work/tmp", GRYPE_DB_CACHE_DIR: "/work", GRYPE_CHECK_FOR_APP_UPDATE: "false" },
});
console.log(r.code === 0 && grypeDbReady() ? `grype database ready in ${dir}` : `grype database update failed (code ${r.code})\n${r.stderr.slice(-400)}`);
process.exit(r.code === 0 && existsSync(join(dir, "6")) ? 0 : 1);
