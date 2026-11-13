// Load the replay snapshot a run saved, and build the zip the report route returns.
//
// proveFindings stores the snapshot's files in replay/<sha256>.json in the
// results folder, and the run record keeps only that hash and the paths. An
// old record keeps the files inline. The normalized finding the page renders
// does not carry either (findings.mjs rebuilds a view of the proof), so the
// bundle reads the raw run file, then the replay file it names.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { buildReplayBundle, bundleRefusal, loadReplayFiles, planReplayBundle, UNJUDGED_NOTE } from "../../spike/lib/replay-bundle.mjs"
import { resultsDir } from "./findings.mjs"

export { buildReplayBundle, bundleRefusal, planReplayBundle, UNJUDGED_NOTE }

// The raw replay for one finding id (`<runId>` or `<runId>.<n>`). Null when
// that run file is not on disk. Missing snapshot fields stay null so the zip
// can say what it could not include.
export function loadRecordedReplay(findingId) {
  const id = String(findingId || "")
  if (!/^[\w.-]+$/.test(id)) return null
  const fileOf = (rid) => path.join(resultsDir(), `run-${rid}.json`)
  let runId = id
  let index = null
  if (!existsSync(fileOf(id))) {
    const m = /^(.*)\.(\d+)$/.exec(id)
    if (!m || !existsSync(fileOf(m[1]))) return null
    runId = m[1]
    index = Number(m[2]) - 1
  }
  let raw
  try { raw = JSON.parse(readFileSync(fileOf(runId), "utf8")) } catch { return null }
  const list = raw?.result?.findings
  const row = index != null ? list?.[index] : (Array.isArray(list) && list.length === 1 ? list[0] : null)
  const proof = row?.proof ?? (index == null ? raw?.result?.proof ?? null : null)
  // The pack names the lab image an http proof ran against.
  const pack = typeof raw?.result?.pack === "string" ? raw.result.pack : typeof row?.pack === "string" ? row.pack : null
  if (!row && !proof) return { runId, index, pack, pocProved: false, script: null, evidence: null, proof: null, replay: null }
  return {
    runId,
    index,
    pack,
    pocProved: (row ? row.pocProved : raw?.result?.pocProved) === true,
    script: row?.script ?? null,
    evidence: row?.evidence ?? null,
    proof,
    replay: loadReplayFiles(proof?.replay ?? row?.replay ?? null, path.join(resultsDir(), "replay")),
  }
}
