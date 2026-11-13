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
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "touchstone-test-store-"))
process.env.TOUCHSTONE_GRANT_TOKEN = "test-grant-token" // the value every app test uses: bun shares one module cache
process.env.TOUCHSTONE_GRANT_TOKEN_FILE = join(dir, "console-token")
process.env.TOUCHSTONE_GRANTS_FILE = join(dir, "grants.json")
process.env.TOUCHSTONE_SCOPES_FILE = join(dir, "scopes.json")
process.on("exit", () => rmSync(dir, { recursive: true, force: true }))

export const TEST_STORE_DIR = dir
