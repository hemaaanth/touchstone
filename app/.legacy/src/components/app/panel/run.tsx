import type { ReactNode } from "react"
import { AlertDialog, Button, Toast } from "@graphical"
import { cn } from "cn"
import { DetailAccordion, Dot, KeyValues, Muted, Section, Tag, type DotTone } from "@/components/app/blocks"
import { ApprovalCard } from "@/components/app/approval"
import { PanelLink } from "@/components/app/cards/frame"
import {
  DIFF_SIGN,
  MODEL_SHORT,
  SANDBOX,
  SLOTS,
  moduleByKey,
  type DiffMark,
  type PlanStep,
  type Run,
  type Tier,
} from "@/data/fixtures"
import { stopLive, useRun } from "@/lib/actions"
import { useWords } from "@/lib/words"

/*
 * The Run panel (MVP panel view 2), sized for the 440px panel.
 * Restraint: only the status line, the one approval, and the result stay open.
 * Run details, plan, agents, sandbox, trace and cleanup fold away, closed by
 * default, so a live run reads as one status line plus one question. The
 * Technical switch still shows the commands inside the folds (A7).
 */

export function RunPanel({ id }: { id: string | null }) {
  const run = useRun(id)
  if (!run) return <Muted>No run with the id {id ?? "(none)"}.</Muted>
  const live = run.status === "running" || run.status === "waiting for you"
  const planDone = run.steps.filter((step) => step.state === "done").length
  const cleanupDone = run.cleanup.filter((item) => item.done).length
  return (
    <div className="flex flex-col gap-(--space-xl)">
      {run.fork ? <ForkBanner text={run.fork.banner} /> : null}
      <Summary run={run} live={live} />
      {run.approval ? <ApprovalCard approval={run.approval} /> : null}
      {run.result ? <Result run={run} /> : null}
      <DetailAccordion
        items={[
          { value: "details", title: "Run details", children: <RunDetails run={run} /> },
          {
            value: "plan",
            title: "Plan",
            meta: `${planDone} of ${run.steps.length}`,
            children: <PlanBody run={run} live={live} />,
          },
          { value: "agents", title: "Agents & models", meta: run.agents.length, children: <AgentsBody run={run} /> },
          { value: "sandbox", title: "Sandbox", children: <SandboxBody run={run} live={live} /> },
          { value: "trace", title: "Trace", meta: run.trace.length, children: <TraceBody run={run} /> },
          {
            value: "cleanup",
            title: "Cleanup",
            meta: `${cleanupDone} of ${run.cleanup.length}`,
            children: <CleanupBody run={run} />,
          },
        ]}
      />
    </div>
  )
}

/* ---------- Words ---------- */

const STATUS: Record<Run["status"], { word: string; tone: DotTone }> = {
  running: { word: "Running", tone: "accent" },
  "waiting for you": { word: "Waiting for you", tone: "warning" },
  done: { word: "Done", tone: "success" },
  stopped: { word: "Stopped", tone: "muted" },
}

const TIER_WORD: Record<Tier, string> = {
  P: "look only",
  S: "safe test",
  I: "intrusive test",
  F: "fork only",
}

const STEP_STATE: Record<PlanStep["state"], { word: string; tone: DotTone }> = {
  done: { word: "Done", tone: "success" },
  running: { word: "Running", tone: "accent" },
  waiting: { word: "Waiting for you", tone: "warning" },
  next: { word: "Next", tone: "muted" },
  skipped: { word: "Skipped", tone: "muted" },
}

const MARK_TONE: Record<DiffMark, DotTone> = {
  New: "error",
  Reopened: "error",
  Fixed: "success",
  Open: "orange",
  Changed: "warning",
  "Not run": "muted",
}

/** The runc fallback shares the host kernel. Its label always says so (D2). */
const SHARED_KERNEL = "container (shared kernel)"

/* ---------- Header ---------- */

function ForkBanner({ text }: { text: string }) {
  return (
    <p className="rounded-(--radius-m) bg-(--cte-surface-muted) px-(--space-m) py-(--space-s) font-data type-xs">
      {text}
    </p>
  )
}

/** The one always-open line: a plain status, the step count, and Stop when live. */
function Summary({ run, live }: { run: Run; live: boolean }) {
  const status = STATUS[run.status]
  // A plain waiting line wins, for example "Waiting for a sandbox (2 of 2 in use)" (D7, Q10).
  const statusText = run.waiting ?? status.word
  return (
    <div className="flex min-h-(--line-l) items-center gap-(--space-s)">
      <Dot tone={status.tone} />
      <span className="type-s weight-medium">{statusText}</span>
      <Muted className="font-data type-s">
        step {run.step} of {run.steps.length}
      </Muted>
      {live ? (
        <div className="ml-auto">
          <StopRun run={run} />
        </div>
      ) : null}
    </div>
  )
}

/** The run facts, folded away by default. */
function RunDetails({ run }: { run: Run }) {
  return (
    <KeyValues
      rows={[
        ["Run mode", run.runMode],
        ["Started by", run.trigger === "Thread" ? "You, in the chat" : `${run.trigger} (automation)`],
        [
          "Time",
          run.finished
            ? `${run.started} to ${run.finished}, ${run.duration}`
            : `Started ${run.started}, ${run.duration} so far`,
        ],
        [
          "Spend",
          <span key="spend">
            <span className="font-data">{run.spend.spent}</span> of a{" "}
            <span className="font-data">{run.spend.quote}</span> quote
          </span>,
        ],
        ["Grant", <span key="grant" className="font-data">{run.grantVersion}</span>],
        ["Scope hash", <span key="hash" className="font-data">{run.scopeHash}</span>],
        ["History scan", run.historyScan ? "On" : "Off. You can turn it on per run."],
      ]}
    />
  )
}

/** Stops this run only. It asks first and names what it cuts. */
export function StopRun({ run, label = "Stop run" }: { run: Run; label?: string }) {
  const toasts = Toast.useToastManager()
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger render={<Button variant="danger" />}>{label}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop />
        <AlertDialog.Popup>
          <AlertDialog.Title>Stop run #{run.id}?</AlertDialog.Title>
          <AlertDialog.Description>
            This cuts the scope proxy for this run first, so nothing more reaches a target. Then it stops the run
            sandbox and revokes the run tokens. Other runs keep going.
          </AlertDialog.Description>
          <div className="flex justify-end gap-(--space-s)">
            <AlertDialog.Close>Keep running</AlertDialog.Close>
            <AlertDialog.Close
              render={<Button variant="danger" />}
              onClick={() => {
                if (!stopLive()) return
                toasts.add({
                  title: `Stopped run #${run.id}`,
                  description: `Scope proxy cut first. Evidence up to step ${run.step - 1} is kept.`,
                })
              }}
            >
              Stop run
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

/* ---------- Result (finished runs) ---------- */

function Result({ run }: { run: Run }) {
  const result = run.result
  if (!result) return null
  return (
    <Section title="Result">
      <p className="type-s">{result.summary}</p>
      <ul className="flex flex-col">
        {result.rows.map((row) => (
          <li key={`${row.mark}-${row.finding ?? row.text}`} className="flex items-start gap-(--space-s) py-(--space-xs) type-s divide-bottom">
            <span aria-hidden="true" className="w-[2ch] shrink-0 font-data tabular-nums text-(--cte-text-muted)">
              {DIFF_SIGN[row.mark]}
            </span>
            <span className="min-w-0 flex-1">
              {row.finding ? (
                <>
                  <PanelLink view={`finding/${row.finding}`} className="font-data">
                    {row.finding}
                  </PanelLink>{" "}
                </>
              ) : null}
              {row.text}
            </span>
            <span className="inline-flex shrink-0 items-center gap-(--space-xxs) type-xs text-(--cte-text-muted)">
              <Dot tone={MARK_TONE[row.mark]} />
              {row.mark}
            </span>
          </li>
        ))}
      </ul>
      <Muted className="type-xs">{result.checksPassed} checks passed with no change.</Muted>
    </Section>
  )
}

/* ---------- Plan ---------- */

function PlanBody({ run, live }: { run: Run; live: boolean }) {
  const { pick, technical } = useWords()
  return (
    <>
      <ol className="flex flex-col">
        {run.steps.map((step) => {
          const state = STEP_STATE[step.state]
          const current = live && step.n === run.step
          return (
            <li
              key={step.n}
              aria-current={current ? "step" : undefined}
              className={cn(
                "flex gap-(--space-s) py-(--space-s) divide-bottom",
                current && "rounded-(--radius-s) bg-(--cte-surface-muted) px-(--space-xs)",
              )}
            >
              <span className="w-[2ch] shrink-0 font-data tabular-nums type-s text-(--cte-text-muted)">{step.n}</span>
              <div className="flex min-w-0 flex-1 flex-col gap-(--space-xxs)">
                <span className={cn("type-s", technical && "font-data break-words")}>
                  {pick(step.plain, step.technical)}
                </span>
                <span className="flex flex-wrap items-center gap-x-(--space-s) gap-y-(--space-xxs) type-xs text-(--cte-text-muted)">
                  <span className="inline-flex items-center gap-(--space-xxs)">
                    <Dot tone={state.tone} />
                    {state.word}
                  </span>
                  <span>
                    Tier <span className="font-data">{step.tier}</span>, {TIER_WORD[step.tier]}
                  </span>
                  <span>{step.profile} sandbox</span>
                  {step.approvedAt ? (
                    <span>
                      You approved it at <span className="font-data">{step.approvedAt}</span>
                    </span>
                  ) : step.needsApproval ? (
                    <span>Needs your OK</span>
                  ) : null}
                </span>
              </div>
            </li>
          )
        })}
      </ol>
      <RunModules run={run} />
    </>
  )
}

/** Modules on or off for this run, with the agent's reason. Each links to Module detail. */
function RunModules({ run }: { run: Run }) {
  return (
    <div className="flex flex-col gap-(--space-xs) pt-(--space-xs)">
      <h3 className="type-xs text-(--cte-text-muted)">Modules in this run</h3>
      <ul className="flex flex-col gap-(--space-xxs) type-s">
        {run.modules.map((row) => (
          <li key={row.key} className="flex items-baseline gap-(--space-s)">
            <PanelLink view={`coverage/${row.key}`} className="shrink-0">
              {moduleByKey(row.key)?.name ?? row.key}
            </PanelLink>
            <Muted className="type-xs">{row.on ? "On" : "Off"}</Muted>
            <Muted className="min-w-0 flex-1 type-xs">{row.why}</Muted>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ---------- Agents and models ---------- */

function AgentsBody({ run }: { run: Run }) {
  return (
    <>
      <ul className="flex flex-col">
        {run.agents.map((agent) => (
          <li key={agent.name} className="flex items-start gap-(--space-s) py-(--space-xs) type-s divide-bottom">
            <div className="flex min-w-0 flex-1 flex-col">
              <span>
                <span className="font-data">{agent.name}</span> <Muted>{agent.role}</Muted>
              </span>
              <Muted className="font-data type-xs">{MODEL_SHORT[agent.model] ?? agent.model}</Muted>
            </div>
            <div className="flex shrink-0 flex-col items-end text-right">
              <span>{agent.state}</span>
              <Muted className="font-data type-xs">{agent.spend}</Muted>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-(--space-xs) pt-(--space-xs)">
        <h3 className="type-xs text-(--cte-text-muted)">Models used, from models.json for this run (A4)</h3>
        <KeyValues
          rows={run.modelsUsed.map((row) => [
            row.role,
            <span key={row.role} className="font-data break-all">
              {row.model}
            </span>,
          ])}
        />
      </div>
    </>
  )
}

/* ---------- Sandbox ---------- */

function SandboxBody({ run, live }: { run: Run; live: boolean }) {
  const sharedKernel = run.isolation === SHARED_KERNEL
  const selfTestOk = run.selfTest.result === "passed"
  const rows: [ReactNode, ReactNode][] = [
    [
      "Isolation",
      <span key="isolation" className="flex flex-col">
        <span>{run.isolation}</span>
        {sharedKernel ? <Muted className="type-xs">I-tier and PoC runs are off.</Muted> : null}
      </span>,
    ],
    [
      "Self-test",
      <span key="self-test" className="inline-flex items-center gap-(--space-xs)">
        <Dot tone={selfTestOk ? "success" : "error"} />
        {selfTestOk ? "Passed" : "Failed"}, {run.selfTest.passed} of {run.selfTest.of} at{" "}
        <span className="font-data">{run.selfTest.at}</span>
      </span>,
    ],
    [
      "Setup window",
      run.setupWindow === "open"
        ? "Open. Clone and package downloads only."
        : "Closed. No more package downloads.",
    ],
  ]
  if (live) rows.push(["Sandboxes in use", <span key="in-use" className="font-data">{SANDBOX.inUseLabel}</span>])
  rows.push([
    "Model slots",
    run.slot ? (
      <span key="slots" className="flex flex-col">
        <span>
          <span className="font-data">{run.slot.share}</span> of {SLOTS.shared} shared slots
        </span>
        <Muted className="type-xs">
          {SLOTS.chat} more stay for the chat. {SLOTS.note}
        </Muted>
      </span>
    ) : (
      "None held. The run is done."
    ),
  ])
  // Show an egress IP only when the provider gives a fixed one (D6).
  if (SANDBOX.egressIp) rows.push(["Egress IP", <span key="egress" className="font-data">{SANDBOX.egressIp}</span>])
  rows.push(["Traffic header", <span key="header" className="font-data break-all">{run.trafficHeader}</span>])

  return (
    <>
      <KeyValues rows={rows} />
      <div className="flex flex-col gap-(--space-xs) pt-(--space-xs)">
        <h3 className="type-xs text-(--cte-text-muted)">
          Outside hosts contacted: <span className="font-data">{run.outsideHosts.length}</span>
        </h3>
        <ul className="flex flex-col">
          {run.outsideHosts.map((host) => (
            <li key={host.host} className="flex items-start gap-(--space-s) py-(--space-xs) type-s divide-bottom">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="font-data break-all">{host.host}</span>
                <Muted className="type-xs">{host.via}</Muted>
              </div>
              <Muted className="shrink-0 type-xs">{host.header ? "Header added" : "No header"}</Muted>
            </li>
          ))}
        </ul>
        {SANDBOX.egressIp ? null : <Muted className="type-xs">{SANDBOX.egressNote}</Muted>}
        <Muted className="type-xs">TLS pass-through hosts and RPC reads get no header.</Muted>
      </div>
    </>
  )
}

/* ---------- Trace and cleanup ---------- */

function TraceBody({ run }: { run: Run }) {
  const { pick, technical } = useWords()
  return (
    <ol className="flex flex-col gap-(--space-xs)">
      {run.trace.map((line, index) => (
        <li key={index} className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-(--space-s) type-s">
          <span className="font-data text-(--cte-text-muted)">{line.at}</span>
          <span className={cn(technical && "font-data break-words")}>{pick(line.plain, line.technical)}</span>
        </li>
      ))}
    </ol>
  )
}

/** What is left to undo after the run (D4). */
function CleanupBody({ run }: { run: Run }) {
  return (
    <ul className="flex flex-col">
      {run.cleanup.map((item) => (
        <li key={item.text} className="flex items-start gap-(--space-s) py-(--space-xs) type-s divide-bottom">
          <span className="flex h-(--line-s) items-center">
            <Dot tone={item.done ? "success" : item.who === "you" ? "warning" : "muted"} />
          </span>
          <span className="min-w-0 flex-1">{item.text}</span>
          {item.done ? (
            <Muted className="shrink-0 type-xs">Done</Muted>
          ) : (
            <Tag className="shrink-0">{item.who === "you" ? "For you" : "Harness"}</Tag>
          )}
        </li>
      ))}
    </ul>
  )
}
