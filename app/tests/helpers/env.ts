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
