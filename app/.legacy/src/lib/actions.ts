import { useSyncExternalStore } from "react"
import {
  ACTION_TIMES,
  AFTER_APPROVE,
  AFTER_DENY,
  APPROVALS,
  FINDINGS,
  HOME_CHAT,
  HOME_STOP_TURN,
  LIVE_RUNS,
  NEEDS_YOU,
  ORG,
  RUNS,
  STOPS,
  findingById,
  type ChatMessage,
  type Finding,
  type PlanStep,
  type Run,
} from "@/data/fixtures"

/*
 * What you did in this tab: confirm a scope, approve or deny a step, accept
 * a verdict, preview a result, stop the live run. One small store, like
 * words.ts. It lives in memory, so a reload starts the story again.
 * Cards, panels and the top bar read the same state, so they always agree.
 */

export type Decision = { kind: "approved" | "denied"; scope: "once" | "run"; at: string }

export type Actions = {
  /** SCOPE_PROPOSALS ids you confirmed. */
  confirmed: string[]
  /** APPROVALS id to your decision. */
  decisions: Record<string, Decision>
  /** Finding id to the time you accepted the machine verdict. */
  accepted: Record<string, string>
  /** The Finding panel plays AFTER_APPROVE. Nothing runs. */
  preview: boolean
  /** STOPS id, once you stop the live run. */
  stop: string | null
}

const START: Actions = { confirmed: [], decisions: {}, accepted: {}, preview: false, stop: null }

let current = START
const listeners = new Set<() => void>()

function update(next: Partial<Actions>) {
  current = { ...current, ...next }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useActions(): Actions {
  return useSyncExternalStore(subscribe, () => current, () => START)
}

/* ---------- Actions ---------- */

export function confirmScope(id: string) {
  if (!current.confirmed.includes(id)) update({ confirmed: [...current.confirmed, id] })
}

/** One decision per approval. A stopped run takes no decision. */
export function decide(id: string, kind: Decision["kind"], scope: Decision["scope"] = "once") {
  if (current.decisions[id] || current.stop) return
  update({ decisions: { ...current.decisions, [id]: { kind, scope, at: ACTION_TIMES.decide } }, preview: false })
}

export function accept(findingId: string) {
  if (!current.accepted[findingId]) update({ accepted: { ...current.accepted, [findingId]: ACTION_TIMES.accept } })
}

export function setPreview(on: boolean) {
  update({ preview: on })
}

/** Stops run #131, the only live run. Returns false when no run is live. */
export function stopLive(): boolean {
  if (current.stop || isApproved(current)) return false
  update({ stop: "stop-all", preview: false })
  return true
}

/* ---------- Reads ---------- */

/** True once you approved step 5 of run #131. */
export function isApproved(actions: Actions): boolean {
  return actions.decisions[AFTER_APPROVE.approval]?.kind === "approved"
}

function steps(run: Run, change: (step: PlanStep) => Partial<PlanStep>): PlanStep[] {
  return run.steps.map((step) => ({ ...step, ...change(step) }))
}

/** The run with your decision or your stop applied. */
export function runWith(run: Run, actions: Actions): Run {
  const approval = run.approval
  if (!approval || approval.id !== AFTER_APPROVE.approval) return run
  const decision = actions.decisions[approval.id]
  const own = (step: PlanStep) => step.n === approval.step

  if (actions.stop) {
    const stop = STOPS[actions.stop]
    return {
      ...run,
      status: "stopped",
      waiting: null,
      finished: stop?.at ?? null,
      slot: null,
      steps: steps(run, (step) => ({
        ...(own(step) ? { needsApproval: false } : {}),
        ...(step.state === "done" ? {} : { state: "skipped" as const }),
      })),
    }
  }
  if (decision?.kind === "approved") {
    return {
      ...run,
      ...AFTER_APPROVE.run,
      slot: null,
      result: AFTER_APPROVE.result,
      steps: steps(run, (step) => ({
        state: "done",
        ...(own(step) ? { needsApproval: false, approvedAt: decision.at } : {}),
      })),
    }
  }
  if (decision?.kind === "denied") {
    return {
      ...run,
      ...AFTER_DENY.run,
      steps: steps(run, (step) => {
        if (own(step)) return { needsApproval: false, state: "skipped" }
        return step.n === AFTER_DENY.run.step ? { state: "running" } : {}
      }),
    }
  }
  return run
}

/** True when step 5 of run #131 will not run: you denied it or stopped the run. */
function proofDropped(actions: Actions): boolean {
  return actions.stop !== null || actions.decisions[AFTER_APPROVE.approval]?.kind === "denied"
}

/** The finding after approve, deny, stop or preview, and after you accept it. */
export function findingWith(finding: Finding, actions: Actions, preview = false): Finding {
  let next = finding
  if (finding.id === AFTER_APPROVE.finding.id && (preview || isApproved(actions))) {
    next = { ...next, ...AFTER_APPROVE.finding }
  } else if (next.proofTest?.state === "waiting" && next.proofTest.run === APPROVALS[AFTER_APPROVE.approval]?.run && proofDropped(actions)) {
    next = { ...next, proofTest: { ...next.proofTest, state: "not run" } }
  }
  const at = actions.accepted[finding.id]
  if (at) {
    next = {
      ...next,
      accepted: next.machineVerdict,
      history: [...next.history, { when: `Nov 8, ${at}`, text: `You accepted ${next.machineVerdict}.` }],
    }
  }
  return next
}

/** What still needs you. A decided or stopped step drops out. */
export function needsYou(actions: Actions) {
  return actions.stop ? [] : NEEDS_YOU.filter((item) => !actions.decisions[item.id])
}

/** LIVE_RUNS after your actions. A done or stopped run drops out. */
export function liveRuns(actions: Actions): typeof LIVE_RUNS {
  return LIVE_RUNS.flatMap((live) => {
    const run = RUNS[String(live.id)]
    const now = run ? runWith(run, actions) : undefined
    if (!run || !now || now === run) return [live]
    if (now.status === "done" || now.status === "stopped") return []
    return [{ ...live, state: "Running", step: `${now.step} of ${now.steps.length}` }]
  })
}

export function spendToday(actions: Actions): string {
  return isApproved(actions) ? AFTER_APPROVE.spendToday : ORG.spendToday
}

/** The Home chat, with the turns your actions add. */
export function homeChat(actions: Actions): ChatMessage[] {
  if (actions.stop) return [...HOME_CHAT, HOME_STOP_TURN]
  if (isApproved(actions)) return [...HOME_CHAT, ...AFTER_APPROVE.chat]
  return HOME_CHAT
}

/* ---------- Hooks ---------- */

export function useRun(id: string | null): Run | undefined {
  const actions = useActions()
  const run = id ? RUNS[id] : undefined
  return run ? runWith(run, actions) : undefined
}

export function useFinding(id: string | null): Finding | undefined {
  const actions = useActions()
  const finding = id ? findingById(id) : undefined
  return finding ? findingWith(finding, actions) : undefined
}

export function useFindings(): Finding[] {
  const actions = useActions()
  return FINDINGS.map((finding) => findingWith(finding, actions))
}
