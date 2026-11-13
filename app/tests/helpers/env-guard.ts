// Preloaded for every `bun test` run (bunfig.toml), after isolated-env.ts.
// bun runs every test file in one process, in the folder's listing order,
// which differs between checkouts. A file that sets a TOUCHSTONE_* variable
// and does not put it back changes what every later file reads: a results
// folder, a token, a store file. That made tests pass in one checkout and fail
// in another. This records the TOUCHSTONE_* values once, before any test file
// loads, and fails the run when they differ at its end. A leak that is never
// put back is still there at the end, so this fails in every file order.
// Set one in a test file with `useEnv` (./env.ts), which puts it back.
import { afterAll } from "bun:test"

const touchstone = () =>
  Object.fromEntries(
    Object.entries(process.env)
      .filter(([k]) => k.startsWith("TOUCHSTONE_"))
      .sort(([a], [b]) => a.localeCompare(b)),
  )
const start = touchstone()

afterAll(() => {
  const end = touchstone()
  const changed = [...new Set([...Object.keys(start), ...Object.keys(end)])].filter((k) => start[k] !== end[k])
  if (changed.length) {
    const what = changed.map((k) => `${k}: ${start[k] ?? "(unset)"} -> ${end[k] ?? "(unset)"}`).join("; ")
    throw new Error(`a test file changed process env and did not put it back (use useEnv from tests/helpers/env.ts): ${what}`)
  }
})
