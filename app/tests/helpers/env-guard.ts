// Preloaded for every `bun test` run (bunfig.toml), after isolated-env.ts.
// bun runs every test file in one process, in the folder's listing order,
// which differs between checkouts. A file that sets a TOUCHSTONE_* or SPEND_* variable
// and does not put it back changes what every later file reads: a results
// folder, a token, a store file, the spend ledger. That made tests pass in one
// checkout and fail in another. This records the TOUCHSTONE_* and SPEND_*
// values once, before any test file loads, and fails the run when they differ
// at its end. A leaked SPEND_LEDGER would point a later file at the real
// ledger, which no test may touch. A leak that is never
// put back is still there at the end, so this fails in every file order.
// Set one in a test file with `useEnv` (./env.ts), which puts it back.
import { afterAll } from "bun:test"
import { envLeaks } from "./env"

const GUARDED = ["TOUCHSTONE_", "SPEND_"]
const touchstone = () =>
  Object.fromEntries(
    Object.entries(process.env)
      .filter(([k]) => GUARDED.some((p) => k.startsWith(p)))
      .sort(([a], [b]) => a.localeCompare(b)),
  )
const start = touchstone()

// The message names the keys only, never a value (envLeaks).
afterAll(() => {
  const leak = envLeaks(start, touchstone())
  if (leak) throw new Error(leak)
})
