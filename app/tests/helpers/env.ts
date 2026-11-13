// Set process env for one test file, and put it back when the file ends.
// bun runs every test file in one process, so a value a file sets and leaves
// is what every later file reads (env-guard.ts fails the run when that
// happens). Call it at the top of the file, where you would assign:
//
//   useEnv({ TOUCHSTONE_RESULTS_DIR: dir })
//
// A beforeEach in the same file may set the same keys again; they are still
// put back to the values from before the first call.
import { afterAll } from "bun:test"

export function useEnv(vars: Record<string, string | undefined>): void {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  const put = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  put(vars)
  afterAll(() => put(before))
}

// What changed between two snapshots of guarded env, for env-guard.ts. It names
// each key and the kind of change only, never a value: a guarded variable can
// hold a token, and a path is not needed to find the leak. Null when nothing
// changed.
export function envLeaks(start: Record<string, string | undefined>, end: Record<string, string | undefined>): string | null {
  const keys = [...new Set([...Object.keys(start), ...Object.keys(end)])].sort()
  const changed = keys.filter((k) => start[k] !== end[k])
  if (!changed.length) return null
  const kind = (k: string) => (start[k] === undefined ? "was unset, now set" : end[k] === undefined ? "was set, now unset" : "value changed")
  return `a test file changed process env and did not put it back (use useEnv from tests/helpers/env.ts): ${changed.map((k) => `${k} (${kind(k)})`).join("; ")}`
}
