// Import this FIRST in a test that loads spike/lib/grant-store.mjs or
// spike/lib/scopes-store.mjs, even through server modules:
//
//   import "./helpers/isolated-env"
//
// grant-store reads (or creates) the console token when it loads, and the
// stores read grants.json and scopes.json under spike/data. In the main
// checkout those are the operator's real token, grants and scopes. Static
// imports run before the test body, so setting env there is too late; a first
// import is not. This points all of them at a throwaway directory, removed when
// the process exits. A test that needs its own values sets them after this
// import. spike/test/test-isolation.test.mjs fails a test that forgets this.
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// `bun test` fires no "exit" event, so the hook below never runs there and the
// folder stays. So the folder name carries this process's id, and each load
// removes the folders of earlier test processes that have ended. Only this
// helper's own prefix, only a process that is gone.
const PREFIX = "touchstone-test-store-"
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}
for (const name of readdirSync(tmpdir())) {
  const m = new RegExp(`^${PREFIX}(\\d+)-[A-Za-z0-9]{6}$`).exec(name)
  if (m && Number(m[1]) !== process.pid && !alive(Number(m[1]))) rmSync(join(tmpdir(), name), { recursive: true, force: true })
}

const dir = mkdtempSync(join(tmpdir(), `${PREFIX}${process.pid}-`))
process.env.TOUCHSTONE_GRANT_TOKEN = "test-grant-token" // the value every app test uses: bun shares one module cache
process.env.TOUCHSTONE_GRANT_TOKEN_FILE = join(dir, "console-token")
process.env.TOUCHSTONE_GRANTS_FILE = join(dir, "grants.json")
process.env.TOUCHSTONE_SCOPES_FILE = join(dir, "scopes.json")
process.on("exit", () => rmSync(dir, { recursive: true, force: true }))

export const TEST_STORE_DIR = dir
