// Reads the REAL recorded engine output and normalizes it into the shape the
// UI renders. No invented values: every field here is lifted from a run the
// engine actually produced (spike/results/agent/run-*.json). A finding is only
// "proven" because a Foundry replay in a sandbox reproduced it.
import { open, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { modulesEvent } from "../../spike/lib/modules.mjs"
import { isProven, proofKind, proofView } from "../../spike/lib/proof-view.mjs"
import { isCandidate, isMeasured, makeCandidate, measuredRule } from "../../spike/lib/candidate.mjs"
import { readableTitle } from "../../spike/lib/check-titles.mjs"
import { measuredOfRecord, recordRowOf } from "./candidates.mjs"
import { PACKS } from "../../spike/packs/index.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
// app/server -> repo root -> spike/results/agent. TOUCHSTONE_RESULTS_DIR is
// how runs.mjs and tests point at a throwaway folder. Read on each call.
export const resultsDir = () => process.env.TOUCHSTONE_RESULTS_DIR || path.resolve(HERE, "../../spike/results/agent")

const num = (s) => Number(String(s).replace(/,/g, ""))

// Pull the per-run facts out of forge's stdout. These strings are the real
// machine output the engine captured; we parse, we do not fabricate.
function parsePocResult(text, index) {
  const compiler = (text.match(/Solc\s+[\d.]+/) || [])[0] || null
  const verdict = text.match(/\[(PASS|FAIL[^\]]*)\]\s+(\w+)\(\)\s+\(gas:\s*([\d,]+)\)/)
  const counts = text.match(/(\d+)\s+passed;\s*(\d+)\s+failed/)
  const pass = /\[PASS\]/.test(text) || /\bok\.\s/.test(text)
  return {
    n: index + 1,
    pass,
    test: verdict ? verdict[2] : null,
    gas: verdict ? num(verdict[3]) : null,
    passed: counts ? num(counts[1]) : null,
    failed: counts ? num(counts[2]) : null,
    compiler,
    raw: text.trim(),
  }
}

// The balance story is read straight from the assertions in the proving PoC.
// Every number here is a literal the test itself asserts — we never invent a
// figure. A row is shown ONLY when it genuinely moved: a before that equals its
// after is not evidence of an exploit, so it is dropped. This keeps the "what
// the exploit moved" panel honest across differently-shaped tests instead of
// leaning on one test's exact variable names.
function parseBalances(testSource) {
  if (!testSource) return []
  const rows = []
  const nums = (re) => [...testSource.matchAll(re)].map((m) => Number(m[1]))

  // Vault: it starts holding the deposits and ends drained. "before" is the
  // largest deposit / totalAssets figure the test sets up; "after" is 0 when the
  // test proves the vault's balance (or totalAssets) reached 0. This covers both
  // the `totalAssets(), 0` shape and the `address(vault).balance, 0` shape.
  const starts = [
    ...nums(/totalAssets\(\),\s*(\d+)\s*ether/g),
    ...nums(/\.deposit\{value:\s*(\d+)\s*ether\}/g),
  ]
  const drained = /vault\)\.balance,\s*0\b/i.test(testSource) || /totalAssets\(\),\s*0\b/.test(testSource)
  if (starts.length && drained) {
    rows.push({ label: "Vault balance", before: `${Math.max(...starts)} ETH`, after: "0 ETH" })
  }

  // Attacker held balance — the earlier test shape names it `drainer` and
  // asserts a literal end balance. Shown only when the test states an exact
  // post-drain figure; a symbolic profit (loot == before + vaultBefore) has no
  // literal to show, so we let the vault-drain row and the assertions carry it.
  const attackerPre = testSource.match(/drainer\)\.balance,\s*(\d+)\)/)
  const attackerPost = testSource.match(/drainer\)\.balance,\s*(\d+)\s*ether/)
  if (attackerPost) {
    rows.push({
      label: "Attacker ETH held",
      before: `${attackerPre ? attackerPre[1] : "0"} ETH`,
      after: `${attackerPost[1]} ETH`,
    })
  }

  // Never show a row that did not move — that is not proof of a drain.
  return rows.filter((r) => r.after && r.after !== r.before)
}

// The harm gate refused this replay. A missing proof is not a refusal: older
// records predate the gate and still count when their own transcript passed.
function harmBlocked(proof) {
  if (!proof || typeof proof !== "object") return false
  if (proof.pass === false || proof.status === "fail") return true
  return Boolean(proof.harm) && proof.harm.ok !== true
}

// The exact assertion lines that make the proof — real strings lifted from the
// passing PoC. These are every condition the replay actually checked, so we take
// the whole Foundry assert family (assertEq / assertGt / assertTrue / …), not
// just assertEq, and we do not invent or paraphrase them — the failure message a
// test passes as its last argument is kept, since it states what the check means.
// Deduped and capped at 8 so the panel stays readable.
function parseAssertions(testSource) {
  if (!testSource) return []
  const seen = new Set()
  const out = []
  for (const m of testSource.matchAll(/assert\w+\([^;]*?\);/g)) {
    const line = m[0].replace(/\s+/g, " ").trim()
    if (seen.has(line)) continue
    seen.add(line)
    out.push(line)
    if (out.length >= 8) break
  }
  return out
}

// Split one stored run into its findings. A multi-finding record has
// `findings[]`, worst first; finding k gets the id `<runId>.<k+1>` and carries its
// own proof, pocProved and dismissed flag. A legacy record has one `finding`,
// keeps the run id as its id, and keeps those fields at the run level.
// A candidate (spike/lib/candidate.mjs) is never a finding. It lives in
// `result.candidates`; a record that holds one under `findings` (forged, or
// written by a bug) still does not list it, count it, open it or export it.
// N3: neither does an older record's finding whose replay only repeated a
// measurement (isMeasured): it reads as a measured candidate (listCandidates).
// The others keep their ids and indexes.
function splitRun(raw, runId) {
  const r = raw.result || {}
  if (Array.isArray(r.findings) && r.findings.length) {
    return r.findings.map((f, k) => ({ id: `${runId}.${k + 1}`, runId, index: k, finding: f })).filter((x) => !isCandidate(x.finding) && !isMeasured(x.finding))
  }
  if (r.finding && !isCandidate(r.finding) && !isMeasured({ ...r.finding, pocProved: r.pocProved, proof: r.proof })) {
    return [{
      id: runId,
      runId,
      index: null,
      finding: { ...r.finding, pocProved: r.pocProved, proof: r.proof, dismissed: r.dismissed },
    }]
  }
  return []
}

function normalize(raw, { id, runId, finding }) {
  const r = raw.result || {}
  const t = raw.transcript || {}
  // Pair each run_poc call with its result by position — the engine emits them
  // in lockstep — so every run carries the contract name it actually ran. That
  // pairing is what lets the proof bind to the SUBMITTED test, not any test.
  const pocResults = (t.results || []).filter((x) => x.name === "run_poc")
  const pocCalls = (t.calls || []).filter((x) => x.name === "run_poc")
  const runs = pocResults.map((x, i) => ({
    ...parsePocResult(x.text || "", i),
    contract: pocCalls[i]?.args?.contract_name || null,
  }))

  // The proving run is the submitted test passing its OWN replay. A throwaway
  // diagnostic that happens to pass never counts — if the submitted contract
  // never passed, the transcript alone does not prove the run. (finding.poc is
  // the contract name the agent submitted; the engine's submit gate already
  // refused an unproven submission, so this re-derivation only mirrors that
  // on read.)
  const submittedContract = finding.poc || null
  const provingIndex = submittedContract
    ? runs.findIndex((x) => x.pass && x.contract === submittedContract)
    : -1
  const proving = provingIndex >= 0 ? runs[provingIndex] : null

  // The engine's structured proof delta, present only on runs recorded after the
  // engine began emitting it and only when something proved. We require a parsable
  // transfers array so a malformed or null delta falls back to the source parse.
  const engineProof = finding.proof && Array.isArray(finding.proof.transfers) ? finding.proof : null

  // A forge finding stays proven when its recorded proof passed the harm gate,
  // even with no root-transcript run_poc. isProven already refuses a failed
  // replay or a harm verdict that is not ok, so a failing or absent proof
  // cannot become proven through this path. A transcript pass still counts for
  // records made before the harm gate, which have no proof.harm. The proof must
  // be for this finding's own test: proveFindings sets proof.contract to its poc.
  const p = finding.proof
  const harmOk = p?.pass === true && p?.harm?.ok === true && (p.contract == null || p.contract === finding.poc)
  const transcriptPass = Boolean(proving && proving.pass)
  const forgeProven = isProven(finding) && (transcriptPass || harmOk)

  // The exploit source is the test the recorder replayed (`finding.source`).
  // A fleet child runs the PoC, and summarize() keeps only the root conversation,
  // so that call is often missing here. The transcript's own proving call is the
  // fallback for older records; the last attempt is what was tried when nothing
  // proved. A finding proven only by its stored proof never falls back to the
  // last attempt: that call may be another contract, and its source, assertions
  // and balance rows would stand in for a test that was not replayed.
  // proof.source is the replay label ("engine-replay"), never the Solidity.
  const submittedSource = typeof finding.source === "string" && finding.source.trim() ? finding.source : null
  const transcriptSource = provingIndex >= 0 ? pocCalls[provingIndex]?.args?.test_source ?? null : null
  const lastAttempt = pocCalls.length ? pocCalls[pocCalls.length - 1]?.args?.test_source ?? null : null
  const testSource = submittedSource || transcriptSource || (forgeProven ? null : lastAttempt) || null

  // The write-up is this finding's own submit call. A run can submit several
  // findings, so match on the label or the test contract it names. In a joined
  // run a tool name that two modules share ends in the module id
  // (submit_finding_web, submit_finding_contracts; spike/packs/multi.mjs), and
  // two modules may share a label, so only this finding's module's call counts.
  // A plain submit_finding is a one-module run, an old record, or the one
  // module of a joined run that has the tool.
  const ownTool = finding.pack ? `submit_finding_${String(finding.pack).replace(/[^A-Za-z0-9_]/g, "_")}` : null
  const joined = Array.isArray(r.packs) && r.packs.length > 1
  const submits = (t.calls || []).filter((x) => x.name === "submit_finding" || (ownTool && x.name === ownTool))
  const named = (x) => x.args?.label ?? x.args?.poc_contract
  const submit = submits.find((x) => finding.poc != null && named(x) === finding.poc) || (!joined && submits.length === 1 ? submits[0] : null)
  const readSrc = (t.results || []).find((x) => x.name === "read_source")

  const modelName = Object.keys((r.usage && r.usage.models) || {})[0] || null
  const modelUsage = modelName ? r.usage.models[modelName] : null

  // The static pre-pass that fed the agent its leads, if one ran. Only shown when
  // it actually flagged something — an empty scan is not a story worth telling.
  const staticScan = r.static && r.static.suspects > 0
    ? {
        tool: r.static.tool || "Slither",
        // Which engines ran, and how the source was compiled ("unit" = one
        // compilation unit, "per-file" = fallback). Older runs carry neither.
        engines: Array.isArray(r.static.engines) ? r.static.engines : ["Slither"],
        mode: r.static.mode || null,
        suspects: r.static.suspects,
        top: (Array.isArray(r.static.top) ? r.static.top : []).map((s) => ({
          check: s.check || "",
          impact: s.impact || "",
          where: s.where || null,
          line: s.line ?? null,
          // Which engines flagged this suspect, and whether more than one did.
          // Corroboration raises a suspect's rank; it never makes it a finding.
          engines: Array.isArray(s.engines) && s.engines.length ? s.engines : ["Slither"],
          corroborated: Boolean(s.corroborated),
        })),
      }
    : null

  // The fuzz pre-pass that broke an invariant, if one did. Only shown when the
  // fuzzer actually broke something — an empty or non-applicable scan is not a
  // story worth telling.
  const fuzzScan = r.fuzz && r.fuzz.suspects > 0
    ? {
        tool: r.fuzz.tool || "Echidna",
        // Which fuzz engines ran. Older runs predate the second engine.
        engines: Array.isArray(r.fuzz.engines) ? r.fuzz.engines : ["Echidna"],
        template: r.fuzz.template || null,
        suspects: r.fuzz.suspects,
        top: (Array.isArray(r.fuzz.top) ? r.fuzz.top : []).map((s) => ({
          check: s.check || "",
          impact: s.impact || "",
          property: s.property || "",
          where: s.where || null,
          sequence: Array.isArray(s.sequence) ? s.sequence : [],
          // Which engines broke this invariant, and whether more than one did.
          // Both fuzzers breaking it raises its rank; it never makes it a finding.
          engines: Array.isArray(s.engines) && s.engines.length ? s.engines : ["Echidna"],
          corroborated: Boolean(s.corroborated),
        })),
      }
    : null

  // Which replay made this finding's proof. http and evidence proofs carry their
  // own record (no Foundry run, no static or fuzz scan); forge is the default and
  // is read exactly as before.
  const kind = proofKind(finding)
  const other = proofView(finding)
  // Which pack produced this finding. Older contracts runs predate the `pack`
  // field; a forge proof identifies them as the contracts pack. A non-forge
  // proof with no saved pack is a module run whose provenance we no longer have
  // — we say Unknown rather than invent "contracts"/"Vault.sol" it never ran.
  // A finding's own `pack` wins: one run can hold several modules, and each
  // finding names the one that made it. Else the run's pack.
  const pack = finding.pack || r.pack || (kind === "forge" ? "contracts" : null)

  return {
    id,
    // The run this finding came from. One run can record several findings.
    runId,
    // A title that is only a check id reads as the check's title (N3).
    title: readableTitle(finding.title, finding.proof?.check ?? finding.evidence?.check ?? finding.proof?.oracle?.name ?? finding.oracleName, measuredRule(finding)) || null,
    severity: finding.severity || null,
    // The attack class the audit assigned, from the sweep in the agent's
    // instructions (spike/lib/attack-classes.mjs). Absent on runs older than the
    // sweep, so it stays absent rather than reading "other" for everything.
    ...(finding.class ? { class: finding.class } : {}),
    ...(pack ? { pack } : {}),
    proofKind: kind,
    // The pack's own pre-pass record, as the run kept it (any shape).
    prepass: r.prepass ?? null,
    module: pack === "contracts" ? "Contracts" : pack ? (PACKS[pack]?.title ?? pack) : "Unknown",
    // Prefer the structured target from the library (new runs); fall back to the
    // transcript's own list_sources for older/CLI runs that predate it.
    target: r.target?.title || (t.results || []).find((x) => x.name === "list_sources")?.text || "Unknown",
    // The structured scope and module plan this run used, kept so a reopened
    // finding can show the same opening `scope` / `modules` the live run streamed.
    // The orchestrator broadcasts those two events at run start, but they live in
    // memory only — the persisted .events file holds the agent child's steps, not
    // them. These fields match the live view() shape; getFinding replays them as
    // opening events for parity. Older runs have a string target / no modules, so
    // both are null and nothing false is shown.
    scope: r.target && typeof r.target === "object" ? r.target : null,
    modules: Array.isArray(r.modules) ? r.modules : null,
    // Verdict ladder — each stage is reached only because the data shows it.
    // A proven exploit is recorded automatically ("auto"); the operator may
    // later dismiss it in the ledger, which is a judgement, not a disproof —
    // so `proven` stays true and only the final stage reads "dismissed".
    stages: {
      hypothesis: other ? true : Boolean(readSrc),
      reproduced: other ? true : runs.length > 0 || forgeProven,
      proven: other ? isProven(finding) : forgeProven,
      accepted: finding.dismissed
        ? "dismissed"
        : r.decision === "approved"
          ? (r.approveMode === "auto" ? "auto" : true)
          : false,
    },
    dismissed: Boolean(finding.dismissed),
    decision: r.decision || null,
    recorded: Boolean(r.recorded),
    proof: other ?? {
      tool: "Foundry",
      compiler: proving ? proving.compiler : null,
      test: engineProof ? engineProof.test : proving ? proving.test : finding.poc,
      contract: finding.poc || null,
      gas: proving ? proving.gas : engineProof ? engineProof.gasUsed : null,
      // A harm-gate failure is never a pass, even when a root run_poc passed.
      // A harm-gated proof with no root run_poc still is.
      pass: harmBlocked(finding.proof) ? false : Boolean(transcriptPass || forgeProven),
      runs,
      // The money the exploit actually moved. Preferred source is the engine's
      // structured proof delta: real signed ETH deltas per address, read from the
      // Foundry trace of the proving replay — machine truth, not source text.
      // `balances` (regex over the test source) stays as the fallback for older
      // runs recorded before the engine emitted a delta.
      transfers: engineProof ? engineProof.transfers.map((x) => ({
        label: x.label,
        address: x.address,
        net: x.net,
        gained: Boolean(x.gained),
        // The exact signed wei, when the record has it: a dust move does not
        // read as "+0 ETH". An older record has none and sends none.
        ...(typeof x.netWei === "string" ? { netWei: x.netWei } : {}),
      })) : [],
      // What the proof gate says was lost (spike/lib/proof.mjs): an ETH or
      // token drain, or a control takeover. Null on a record from before it.
      harm: engineProof?.harm ?? null,
      // The real runtime log lines the proving test emitted (decoded by forge),
      // verbatim machine output — empty for older runs.
      logs: engineProof && Array.isArray(engineProof.logs) ? engineProof.logs : [],
      balances: parseBalances(testSource),
      assertions: parseAssertions(testSource),
      rerunCommand: proving?.test || (forgeProven && engineProof?.test)
        ? `forge test --match-test ${proving?.test || engineProof.test}`
        : null,
      testSource,
    },
    staticScan: other ? null : staticScan,
    fuzzScan: other ? null : fuzzScan,
    hypothesis: readSrc ? (readSrc.text || "").trim() : null,
    explanation: finding.explanation || (submit ? submit.args.explanation : null),
    calls: r.calls || [],
    model: modelName,
    usage: {
      usd: r.usage ? r.usage.usd : null,
      in: modelUsage ? modelUsage.in : null,
      out: modelUsage ? modelUsage.out : null,
      reasoning: modelUsage ? modelUsage.reasoning : null,
    },
    ms: r.ms || null,
  }
}

// Each finding of one stored run, by its ledger id, with the verdict the
// Findings page shows for it (normalize's stages.proven, today's rule). The
// run view reads this too (runs.mjs provenByRecord), so the two never
// disagree. Only rows of the record: nothing unrecorded is in it.
export function recordProven(raw, runId) {
  const out = new Map()
  for (const item of splitRun(raw ?? {}, runId)) {
    try {
      out.set(item.id, { proven: normalize(raw, item).stages.proven === true, finding: item.finding })
    } catch {
      out.set(item.id, { proven: false, finding: item.finding })
    }
  }
  return out
}

async function readRuns() {
  let entries = []
  try {
    entries = await readdir(resultsDir())
  } catch {
    return []
  }
  const files = entries.filter((f) => f.startsWith("run-") && f.endsWith(".json")).sort()
  const out = []
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(path.join(resultsDir(), file), "utf8"))
      const runId = file.replace(/^run-/, "").replace(/\.json$/, "")
      for (const item of splitRun(raw, runId)) {
        out.push({ ...normalize(raw, item), _index: item.index })
      }
    } catch {
      // A malformed or partial file is skipped, never shown as a fake finding.
    }
  }
  return out
}

// When a run started: the time of its first engine event, the same time the
// report shows (report.mjs runAt). Only the head of the events file is read: the
// file can be tens of MB. Null when the run kept no events; the file's own date
// is not used, because a copy or a checkout changes it.
async function runStartedAt(runId) {
  let file
  try {
    file = await open(path.join(resultsDir(), `run-${runId}.events`))
    const { buffer, bytesRead } = await file.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0)
    for (const line of buffer.toString("utf8", 0, bytesRead).split("\n")) {
      try {
        const t = JSON.parse(line)?.t
        if (Number.isFinite(t)) return t
      } catch {
        // A line cut by the 64 KB read, or a torn line.
      }
    }
  } catch {
    // No events file.
  } finally {
    await file?.close()
  }
  return null
}

// A candidate's id comes from what it is, not from where it sits in a list:
// the run, the module, its origin and its poc (unique in a run; a measured
// candidate's poc is its first finding's). So a follow-up that adds a
// candidate, or a dismissal, moves no id, and two copies of one row (an
// older record's finding read as a candidate, and that same candidate if a
// record ever held it) have one id and list once.
export const candidateId = (runId, c) =>
  `${runId}.c-${createHash("sha256").update(`${c.pack ?? ""}\u0000${c.origin ?? "agent"}\u0000${c.poc ?? ""}`).digest("hex").slice(0, 12)}`

// The candidates of one stored run: its own `result.candidates` (the agent's,
// and the measured ones a newer run recorded), then the measured candidates
// its older finding rows read as (derived at each read). One per id.
function runCandidates(raw, runId) {
  const r = raw.result || {}
  const own = (Array.isArray(r.candidates) ? r.candidates : []).map((c) => makeCandidate(c ?? {}))
  const derived = measuredOfRecord(runId, r, Math.max(0, ...own.map((c) => Number(c.n) || 0))).candidates
  const out = new Map()
  for (const c of [...own, ...derived]) {
    const id = candidateId(runId, c)
    if (!out.has(id)) out.set(id, { ...c, id, runId })
  }
  return [...out.values()]
}

const moduleOf = (pack) => (pack === "contracts" ? "Contracts" : pack ? (PACKS[pack]?.title ?? pack) : "Unknown")

// Every candidate of every stored run, with the fields a list row needs. A
// candidate is never proven and has no report or bundle in this pass.
export async function listCandidates() {
  let entries = []
  try {
    entries = await readdir(resultsDir())
  } catch {
    return []
  }
  const out = []
  for (const file of entries.filter((f) => f.startsWith("run-") && f.endsWith(".json")).sort()) {
    try {
      const raw = JSON.parse(await readFile(path.join(resultsDir(), file), "utf8"))
      const runId = file.replace(/^run-/, "").replace(/\.json$/, "")
      const r = raw.result || {}
      const at = await runStartedAt(runId)
      for (const c of runCandidates(raw, runId)) {
        const pack = c.pack || r.pack || null
        out.push({
          id: c.id,
          runId,
          kind: "candidate",
          title: readableTitle(c.title, c.measured?.check, c.measured?.rule) || null,
          severity: c.severity,
          module: moduleOf(pack),
          pack,
          target: r.target?.title || "Unknown",
          scope: r.target && typeof r.target === "object" ? (r.target.title ?? null) : null,
          at,
          // The candidate's poc: the run view finds the candidate by it (N3, M2).
          poc: c.poc,
          origin: c.origin,
          measured: c.measured ? { reason: c.measured.reason, words: c.measured.words, count: c.measured.count, check: c.measured.check, rule: c.measured.rule } : null,
          proven: false,
        })
      }
    } catch {
      // A malformed or partial file is skipped, never shown as a fake candidate.
    }
  }
  return out
}

export async function listFindings() {
  const all = await readRuns()
  const started = new Map()
  for (const f of all) if (!started.has(f.runId)) started.set(f.runId, await runStartedAt(f.runId))
  // The list shows only the few fields a row needs.
  return all.map((f) => ({
    id: f.id,
    runId: f.runId,
    title: f.title,
    severity: f.severity,
    module: f.module,
    pack: f.pack ?? null,
    target: f.target,
    // The scope the run used (newer runs), and when the run started.
    scope: f.scope?.title ?? null,
    at: started.get(f.runId),
    stages: f.stages,
    proven: f.stages.proven,
    dismissed: f.dismissed,
    ms: f.ms,
  }))
}

// The agent's own step-by-step transcript, persisted beside the result as one
// `EVENT`-shaped JSON object per line (run-<id>.events). The live run streams the
// same objects; reading them back lets the history view replay the conversation
// read-only, so a recorded finding is never a dead end with no way back to the
// agent's work. Missing or torn lines are skipped, never shown as a fake step.
async function readEvents(id) {
  try {
    const text = await readFile(path.join(resultsDir(), `run-${id}.events`), "utf8")
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

// `events: false` leaves the run's transcript out (events: []). The Findings
// page's sheet shows only the finding and its proof, and a run's events can
// be tens of MB.
export async function getFinding(id, { events: withEvents = true } = {}) {
  const all = await readRuns()
  const found = all.find((f) => f.id === id) || null
  if (!found) return null
  const { _index, ...rest } = found
  // When the run started (ms), as the list sends it. `ms` is the run's
  // duration, so a reader that wants a date uses this (replay-bundle.mjs
  // provenDate takes `at` first).
  const finding = { ...rest, at: await runStartedAt(rest.runId) }
  if (!withEvents) return { ...finding, events: [] }
  // The transcript belongs to the run, which may hold several findings.
  const events = await readEvents(finding.runId)
  // Replay the opening `scope` and `modules` events a live run streams but the
  // persisted .events file omits (the orchestrator broadcasts them in memory
  // only). Built from the saved record so history matches a live run, and only
  // when the stream does not already carry them — so we never double up if the
  // write path later persists them, and old runs without a plan show nothing.
  const t0 = events.find((e) => e.t)?.t ?? null
  const opening = []
  if (finding.scope && !events.some((e) => e.ev === "scope")) {
    opening.push({ t: t0, ev: "scope", scope: finding.scope })
  }
  if (finding.modules && !events.some((e) => e.ev === "modules")) {
    opening.push({ ...modulesEvent(finding.modules), t: t0 })
  }
  return { ...finding, events: [...opening, ...events] }
}

// Ledger override: mark a recorded finding dismissed (or restore it). This is a
// human judgement written back onto the run's own record — it never re-runs the
// engine and never touches the proof. The replay still happened; dismissal only
// says "I don't count this as a finding I care about."
export async function dismissFinding(id, dismissed) {
  if (!/^[\w.-]+$/.test(id)) throw new Error("bad finding id")
  const target = (await readRuns()).find((f) => f.id === id)
  if (!target) throw new Error("no such finding")
  const file = path.join(resultsDir(), `run-${target.runId}.json`)
  const raw = JSON.parse(await readFile(file, "utf8"))
  raw.result = raw.result || {}
  // A multi-finding record keeps the flag on the finding itself; a legacy
  // single-finding record keeps it on the run.
  if (target._index != null && raw.result.findings?.[target._index]) {
    raw.result.findings[target._index].dismissed = Boolean(dismissed)
  } else {
    raw.result.dismissed = Boolean(dismissed)
  }
  await writeFile(file, JSON.stringify(raw, null, 2))
  return { id, dismissed: Boolean(dismissed) }
}

// For an id that is not a finding (getFinding gave null): if it names an
// older record's row that is now a measured candidate, say so, with its run
// and the candidate's id. Null for any other id. Used by the 404 answers, so
// an old link reads "This item is now a candidate" instead of a bare not found.
export const NOW_CANDIDATE = "This item is now a candidate: its replay only repeated a measurement, so it is not proven. It has no report."
export async function nowCandidate(id) {
  const m = /^([\w.-]+?)(?:\.(\d+))?$/.exec(String(id ?? ""))
  if (!m) return null
  for (const runId of m[2] ? [m[1]] : [m[1], String(id)]) {
    let raw
    try {
      raw = JSON.parse(await readFile(path.join(resultsDir(), `run-${runId}.json`), "utf8"))
    } catch {
      continue
    }
    const rows = measuredOfRecord(runId, raw.result || {})
    if (!rows.ids.has(String(id))) continue
    const row = recordRowOf(runId, raw.result || {}, String(id))
    const c = rows.candidates.find((x) => (x.evidence?.items ?? []).some((i) => i.poc === row?.poc)) ?? null
    return { error: NOW_CANDIDATE, candidate: true, runId, candidateId: c ? candidateId(runId, c) : null, poc: c?.poc ?? null }
  }
  return null
}
