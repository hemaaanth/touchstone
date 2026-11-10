import {
  ASSETS,
  FINDINGS,
  MODULES,
  SANDBOX,
  assetById,
  type Access,
  type Finding,
  type Module,
  type Severity,
  type Verdict,
} from "@/data/fixtures"

/*
 * The Answer, computed in code. No model sets it. The abliterated judge
 * cannot change these rules, so every guardrail here is plain code.
 *
 * Rules (decision Q8, critic notes B1 to B5):
 * - No score. The state is "OK for what we checked", "Not OK" or
 *   "Can't tell yet".
 * - Not OK: an open High or Critical finding. Open means not
 *   "Not exploitable" and not "Fixed".
 * - Can't tell yet: the sandbox is down, or fewer than half of the modules
 *   that are on were checked.
 * - Otherwise: OK for what we checked. Public-only coverage never claims
 *   the code is clean.
 * - A module is checked only when it ran on every asset it fits (B3).
 * - An open finding on a module and asset wins over "ok" in that cell (B1).
 */

export type AnswerState = "OK for what we checked" | "Not OK" | "Can't tell yet"

/** One cell of the coverage grid: one module on one asset. */
export type CellState = "found" | "ok" | "partial" | "needs source" | "not run" | "off" | "not relevant"

const SEVERITY_ORDER: Record<Severity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 }

const VERDICT_ORDER: Record<Verdict, number> = {
  Proven: 0,
  Likely: 1,
  Unproven: 2,
  "Not exploitable": 3,
  Fixed: 4,
}

/** Lowers a verdict to a limit. Lower order is a stronger claim. */
function capAt(verdict: Verdict, limit: Verdict): Verdict {
  return VERDICT_ORDER[verdict] < VERDICT_ORDER[limit] ? limit : verdict
}

/**
 * The verdict the evidence allows. The cap always wins.
 * - Proven needs a passing proof test.
 * - A NEAR (Limited) asset stays at Unproven until a near-sandbox test passes.
 * - Closed verdicts ("Not exploitable", "Fixed") pass through.
 */
export function verdictOf(finding: Finding): Verdict {
  const claimed = finding.accepted ?? finding.machineVerdict
  if (claimed === "Not exploitable" || claimed === "Fixed") return claimed

  // The cap from the inputs. Pattern match alone caps at Unproven,
  // decompiled bytecode plus a second check caps at Likely.
  let verdict = capAt(claimed, finding.cap)
  // Proven needs the proof test to pass.
  if (finding.proofTest?.state !== "passed") verdict = capAt(verdict, "Likely")
  // NEAR is Limited: Unproven until a near-sandbox test passes.
  const nearPassed = finding.proofTest?.kind === "near-sandbox test" && finding.proofTest.state === "passed"
  if (assetById(finding.asset)?.limited && !nearPassed) verdict = capAt(verdict, "Unproven")
  return verdict
}

/** The words for a verdict. "Proven (machine)" until you accept it (B5). */
export function verdictLabel(finding: Finding): string {
  const verdict = verdictOf(finding)
  if (verdict === "Proven" && finding.accepted !== "Proven") return "Proven (machine)"
  return verdict
}

export function isOpen(finding: Finding): boolean {
  const verdict = verdictOf(finding)
  return verdict !== "Not exploitable" && verdict !== "Fixed"
}

/** Open findings, worst first: severity, then verdict. */
export function openFindings(findings: Finding[] = FINDINGS): Finding[] {
  return findings
    .filter(isOpen)
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        VERDICT_ORDER[verdictOf(a)] - VERDICT_ORDER[verdictOf(b)],
    )
}

/**
 * One coverage cell. Order: off, not relevant, found, then what ran.
 * An open finding wins over "ok".
 */
export function cellState(module: Module, assetId: string, findings: Finding[] = FINDINGS): CellState {
  if (!module.on) return "off"
  const entry = module.assets.find((row) => row.asset === assetId)
  if (!entry) return "not relevant"
  const found = findings.some((f) => f.module === module.key && f.asset === assetId && isOpen(f))
  if (found) return "found"
  return entry.run
}

/** How many fitting assets the module ran on. "partial" counts as ran. */
export function ranOn(module: Module): { ran: number; of: number } {
  const ran = module.assets.filter((row) => row.run === "ok" || row.run === "partial").length
  return { ran, of: module.assets.length }
}

/** Checked: on, fits at least one asset, and ran on every one (B3). */
export function moduleChecked(module: Module): boolean {
  if (!module.on || module.assets.length === 0) return false
  const { ran, of } = ranOn(module)
  return ran === of
}

/** "Source + Public", "Source" or "Public". In-scope assets only. */
export function accessMix(assets: { tier: string; access: Access }[] = ASSETS): string {
  const inScope = assets.filter((asset) => asset.tier !== "Never touch")
  const hasSource = inScope.some((asset) => asset.access === "Source")
  const hasPublic = inScope.some((asset) => asset.access === "Public")
  if (hasSource && hasPublic) return "Source + Public"
  return hasSource ? "Source" : "Public"
}

/** In-scope assets by access, for the count-by-access line (B2). */
export function countByAccess(assets: { tier: string; access: Access }[] = ASSETS): Record<Access, number> {
  const inScope = assets.filter((asset) => asset.tier !== "Never touch")
  return {
    Source: inScope.filter((asset) => asset.access === "Source").length,
    Public: inScope.filter((asset) => asset.access === "Public").length,
  }
}

/** Notes from every cell that did not fully run (B2). */
export function couldNotSee(modules: Module[] = MODULES): string[] {
  return modules
    .filter((module) => module.on)
    .flatMap((module) => module.assets.filter((row) => row.run !== "ok" && row.note).map((row) => row.note as string))
}

export type Answer = {
  state: AnswerState
  /** Plain reason for the state, one line. */
  reason: string
  /** Open findings, worst first. "N things to fix". */
  fixes: Finding[]
  checked: number
  /** Always 13: the catalog size. "Checked N of 13". */
  of: number
  on: number
  accessMix: string
  byAccess: Record<Access, number>
  couldNotSee: string[]
}

export function answer(
  input: { findings?: Finding[]; modules?: Module[]; sandboxOk?: boolean } = {},
): Answer {
  const findings = input.findings ?? FINDINGS
  const modules = input.modules ?? MODULES
  const sandboxOk = input.sandboxOk ?? SANDBOX.selfTest.result === "passed"

  const fixes = openFindings(findings)
  const on = modules.filter((module) => module.on).length
  const checked = modules.filter(moduleChecked).length
  const worst = fixes.find((f) => f.severity === "Critical" || f.severity === "High")

  let state: AnswerState
  let reason: string
  if (worst) {
    state = "Not OK"
    reason = `${worst.id} is ${worst.severity} and open.`
  } else if (!sandboxOk) {
    state = "Can't tell yet"
    reason = "The run sandbox is down. No run can start."
  } else if (checked < on / 2) {
    state = "Can't tell yet"
    reason = `Only ${checked} of ${on} modules that are on were checked.`
  } else {
    state = "OK for what we checked"
    reason = "No open High or Critical finding."
  }

  return {
    state,
    reason,
    fixes,
    checked,
    of: modules.length,
    on,
    accessMix: accessMix(),
    byAccess: countByAccess(),
    couldNotSee: couldNotSee(modules),
  }
}
