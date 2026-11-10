import { Button, Collapsible, Meter, Progress, Switch, ThemedIcon, Toast } from "@graphical"
import { Dot, KeyValues, Muted, ProofBlock, SeverityLabel, Tag } from "@/components/app/blocks"
import { SEVERITY_TONE, VERDICT_TONE, type DotTone } from "@/lib/tones"
import {
  APPROVAL_VARIANTS,
  APPROVALS,
  ASSETS,
  DIFF_SIGN,
  GRANT,
  MODEL_SHORT,
  MODELS,
  MODULES,
  NEAR_LIMITED,
  PROJECT,
  SANDBOX,
  SLOTS,
  assetById,
  moduleByKey,
  type Approval,
  type DiffMark,
  type Module,
  type PlanStep,
  type Run,
  type Tier,
} from "@/data/fixtures"
import { decide, useActions, useFinding, useFindings, useRun } from "@/lib/actions"
import {
  answer,
  moduleChecked,
  openFindings,
  ranOn,
  verdictLabel,
  verdictOf,
  type AnswerState,
  type CellState,
} from "@/lib/answer"
import { panelHref } from "@/lib/route"
import { useWords } from "@/lib/words"
import { DisclosureDraftDialog, ReportDraftDialog } from "@/components/app/drafts"
import { StopRun } from "@/components/app/panel/run"
import { CardFrame, MissingCard, PanelLink } from "./frame"

/*
 * The core chat cards.
 * Every card takes { id } and reads its fixture. The model fills word fields
 * only. Code computes every verdict, state and count, so a guardrail never
 * rests on a model. The Answer comes from lib/answer.ts. No score, ever.
 * Words: Plain by default, Technical on the words toggle. "confirm", not "sign".
 */

/* ---------- Shared maps ---------- */

const ANSWER_TONE: Record<AnswerState, DotTone> = {
  "Not OK": "error",
  "Can't tell yet": "warning",
  "OK for what we checked": "success",
}

/** One cell of the coverage strip: the whole module, not one asset. */
const CELL_TONE: Record<CellState, DotTone> = {
  found: "error",
  ok: "success",
  partial: "orange",
  "needs source": "warning",
  "not run": "muted",
  off: "muted",
  "not relevant": "muted",
}

const CELL_LABEL: Record<CellState, string> = {
  found: "Found",
  ok: "OK",
  partial: "Partial",
  "needs source": "Needs source",
  "not run": "Not run",
  off: "Off",
  "not relevant": "Not here",
}

const LEGEND_ORDER: CellState[] = ["found", "ok", "partial", "needs source", "not run", "off"]

const TIER_WORD: Record<Tier, string> = {
  P: "Look only",
  S: "Safe test",
  I: "Intrusive test",
  F: "Fork-only test",
}

const STEP_TONE: Record<PlanStep["state"], DotTone> = {
  done: "success",
  running: "accent",
  waiting: "warning",
  next: "muted",
  skipped: "muted",
}

const RUN_STATUS: Record<Run["status"], string> = {
  running: "Running",
  "waiting for you": "Waiting for you",
  done: "Done",
  stopped: "Stopped",
}

const MARK_TONE: Record<DiffMark, DotTone> = {
  New: "error",
  Reopened: "error",
  Fixed: "success",
  Open: "orange",
  Changed: "orange",
  "Not run": "muted",
}

/** One strip cell state, rolled up from the module's assets and open findings. */
function moduleStripState(module: Module, openModules: Set<string>): CellState {
  if (!module.on) return "off"
  if (openModules.has(module.key)) return "found"
  if (moduleChecked(module)) return "ok"
  const { ran } = ranOn(module)
  if (ran > 0) return "partial"
  if (module.assets.length > 0 && module.assets.every((row) => row.run === "needs source")) return "needs source"
  return "not run"
}

/** "$1.08" to 1.08. For the spend meter. */
function money(text: string): number {
  return Number(text.replace(/[^0-9.]/g, "")) || 0
}

/* ---------- Answer ---------- */

/** The Answer. State is set in code (lib/answer.ts), never by a model. id: "acme". */
export function AnswerCard({ id: _id }: { id: string }) {
  const result = answer({ findings: useFindings() })
  const openModules = new Set(result.fixes.map((fix) => fix.module))
  const partial = MODULES.filter((module) => module.on && !moduleChecked(module) && ranOn(module).ran > 0).length
  const legend = LEGEND_ORDER.filter((state) => MODULES.some((module) => moduleStripState(module, openModules) === state))

  return (
    <CardFrame title="Answer" tone={ANSWER_TONE[result.state]} meta={`${PROJECT.name} · Grant ${GRANT.version}`}>
      <p className="type-l weight-medium">{result.state}</p>
      <p>{result.reason}</p>

      <div className="flex flex-col gap-(--space-xs)">
        <Muted className="type-xs">
          {result.fixes.length ? `${result.fixes.length} things to fix, worst first` : "Nothing to fix"}
        </Muted>
        {result.fixes.length ? (
          <ul className="flex flex-col gap-(--space-xs)">
            {result.fixes.map((fix) => (
              <li key={fix.id} className="flex flex-wrap items-center gap-(--space-s)">
                <SeverityLabel severity={fix.severity} />
                <PanelLink view={`finding/${fix.id}`} className="font-data">
                  {fix.id}
                </PanelLink>
                <span className="min-w-0 flex-1 truncate">{fix.title}</span>
                <Tag tone={VERDICT_TONE[verdictOf(fix)]}>{verdictLabel(fix)}</Tag>
                {assetById(fix.asset)?.limited ? <Tag>Limited</Tag> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex flex-col gap-(--space-xxs)">
        <span className="font-data">
          Checked {result.checked} of {result.of}. {partial} partial.
        </span>
        <Muted>
          {result.accessMix}. Source {result.byAccess.Source}, Public {result.byAccess.Public}.
        </Muted>
      </div>

      <div className="flex flex-col gap-(--space-xs)">
        <Muted className="type-xs">Coverage, 13 modules. Open one to see where it ran.</Muted>
        <div className="flex flex-wrap gap-(--space-xxs)">
          {MODULES.map((module) => {
            const state = moduleStripState(module, openModules)
            return (
              <a
                key={module.key}
                href={panelHref(`coverage/${module.key}`)}
                title={`${module.name}: ${CELL_LABEL[state]}`}
                className="inline-flex items-center gap-(--space-xxs) rounded-(--radius-xs) bg-(--cte-surface-muted) px-(--space-xs) py-(--space-xxs) font-data type-xs hover:bg-(--neutral-3) focus-ring"
              >
                <Dot tone={CELL_TONE[state]} />
                {module.n}
              </a>
            )
          })}
        </div>
        <div className="flex flex-wrap items-center gap-x-(--space-m) gap-y-(--space-xxs) type-xs text-(--cte-text-muted)">
          {legend.map((state) => (
            <span key={state} className="inline-flex items-center gap-(--space-xxs)">
              <Dot tone={CELL_TONE[state]} />
              {CELL_LABEL[state]}
            </span>
          ))}
        </div>
      </div>

      {result.couldNotSee.length ? (
        <div className="flex flex-col gap-(--space-xs)">
          <Muted className="type-xs">What we could not see</Muted>
          <ul className="flex flex-col gap-(--space-xxs)">
            {result.couldNotSee.map((note, index) => (
              <li key={index} className="flex gap-(--space-xs)">
                <span aria-hidden="true">·</span>
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </CardFrame>
  )
}

/* ---------- Plan ---------- */

/** Plan for a run. Confirm accepts the plan but approves no step (A2). id: "131", "129". */
export function PlanCard({ id }: { id: string }) {
  const { pick } = useWords()
  const run = useRun(id)
  if (!run) return <MissingCard kind="plan" id={id} />
  const driver = SANDBOX.drivers.find((entry) => entry.isolation === run.isolation)
  const modulesOn = run.modules.filter((module) => module.on).length

  return (
    <CardFrame
      title={`Plan for run #${run.id}: ${run.title}`}
      meta={`Run mode: ${run.runMode} · ${run.steps.length} steps`}
      actions={<Button>Confirm plan</Button>}
    >
      <ol className="flex flex-col gap-(--space-xs)">
        {run.steps.map((step) => {
          const active = step.state === "waiting" || step.state === "running"
          return (
            <li key={step.n} className="flex flex-wrap items-start gap-(--space-s)">
              <span className="flex items-center gap-(--space-xs)">
                <Dot tone={STEP_TONE[step.state]} />
                <span className="font-data tabular-nums text-(--cte-text-muted)">{step.n}</span>
              </span>
              <span className={`min-w-0 flex-1 ${active ? "weight-medium" : ""}`}>{pick(step.plain, step.technical)}</span>
              <span className="flex shrink-0 flex-wrap items-center gap-(--space-xs)">
                <Tag>{pick(TIER_WORD[step.tier], `Tier ${step.tier}`)}</Tag>
                <Tag>{step.profile}</Tag>
                {step.approvedAt ? (
                  <Tag tone="success">You approved it at {step.approvedAt}</Tag>
                ) : step.needsApproval ? (
                  <Tag tone="warning">asks you</Tag>
                ) : null}
              </span>
            </li>
          )
        })}
      </ol>

      <Collapsible.Root className="w-full">
        <Collapsible.Trigger className="flex items-center gap-(--space-xs) rounded-(--radius-xs) type-s weight-medium focus-ring">
          Modules in this run ({modulesOn} on)
          <Collapsible.Indicator>
            <ThemedIcon name="chevronRight" />
          </Collapsible.Indicator>
        </Collapsible.Trigger>
        <Collapsible.Panel>
          <Collapsible.Content>
            <ul className="flex flex-col gap-(--space-xs) pt-(--space-xs)">
              {run.modules.map((row) => {
                const module = moduleByKey(row.key)
                return (
                  <li key={row.key} className="flex flex-col gap-(--space-xxs)">
                    <span className="flex flex-wrap items-center gap-(--space-xs)">
                      <Dot tone={row.on ? "success" : "muted"} />
                      <span className="weight-medium">{module?.name ?? row.key}</span>
                      <Muted>{row.on ? "on" : "off"}</Muted>
                      {module ? <Tag>Needs {module.needs}</Tag> : null}
                    </span>
                    <Muted>{row.why}</Muted>
                  </li>
                )
              })}
            </ul>
          </Collapsible.Content>
        </Collapsible.Panel>
      </Collapsible.Root>

      <div className="flex flex-col gap-(--space-xxs)">
        <Switch.Row>
          <Switch.Root defaultChecked={run.historyScan} />
          <Switch.Label>Scan git history for secrets (deeper clone)</Switch.Label>
        </Switch.Row>
        <Muted className="type-xs">Off by default. It clones more history, so it takes longer.</Muted>
      </div>

      <Muted className="type-xs">
        Isolation: {run.isolation}.{driver?.note ? ` ${driver.note}` : ""}
      </Muted>
      <Muted className="type-xs">
        Confirm accepts the plan. It approves no step. Each test asks you when the run reaches it.
      </Muted>
      <PanelLink view={`run/${run.id}`}>Open run #{run.id}</PanelLink>
    </CardFrame>
  )
}

/* ---------- Approval ---------- */

function approvalById(id: string): Approval | undefined {
  return APPROVALS[id] ?? APPROVAL_VARIANTS.find((approval) => approval.id === id)
}

/** One waiting step. "Approve for this run" shows for S-tier only (A1). id: "131-5". */
export function ApprovalCard({ id }: { id: string }) {
  const approval = approvalById(id)
  if (!approval) return <MissingCard kind="approval" id={id} />
  return <ApprovalBody approval={approval} />
}

function ApprovalBody({ approval }: { approval: Approval }) {
  const toasts = Toast.useToastManager()
  const decision = useActions().decisions[approval.id]
  const run = useRun(String(approval.run))
  const live = run?.status === "running" || run?.status === "waiting for you"
  const stopped = !decision && run?.status === "stopped"
  const judge = MODELS.find((model) => model.role === "Judge")
  const judgeModel = judge ? (MODEL_SHORT[judge.model] ?? judge.model) : "the judge model"

  function choose(kind: "approved" | "denied", scope: "once" | "run" = "once") {
    decide(approval.id, kind, scope)
    toasts.add({
      title:
        kind === "denied"
          ? `Denied step ${approval.step}`
          : `Approved step ${approval.step} ${scope === "run" ? "for this run" : "once"}`,
      description: `Written to the audit log. Fingerprint ${approval.fingerprint}.`,
    })
  }

  let outcome: string | null = null
  if (decision?.kind === "approved") {
    outcome = `You approved step ${approval.step} ${decision.scope === "run" ? "for this run" : "once"} at ${decision.at}.`
  } else if (decision) {
    outcome = `You denied step ${approval.step} at ${decision.at}. The run goes on without it.`
  } else if (stopped) {
    outcome = `You stopped run #${approval.run} before you decided. Step ${approval.step} did not run.`
  }

  return (
    <CardFrame
      title={`Approve step ${approval.step} of run #${approval.run}?`}
      tone={decision?.kind === "approved" ? "success" : outcome ? "muted" : "warning"}
      meta={`Tier ${approval.tier} · Run mode: ${approval.runMode}`}
      actions={
        outcome ? (
          <span className="flex flex-wrap items-center gap-(--space-s)">
            <span>{outcome}</span>
            {run ? <PanelLink view={`run/${run.id}`}>Open run #{run.id}</PanelLink> : null}
          </span>
        ) : (
          <>
            <Button onClick={() => choose("approved")}>Approve</Button>
            {approval.tier === "S" ? (
              <Button variant="secondary" onClick={() => choose("approved", "run")}>
                Approve for this run
              </Button>
            ) : null}
            <Button
              variant="outline"
              onClick={() =>
                toasts.add({
                  title: "Say what to change in the chat",
                  description: "The step keeps waiting until you decide.",
                })
              }
            >
              Change
            </Button>
            <Button variant="outline" onClick={() => choose("denied")}>
              Deny
            </Button>
            {run && live ? <StopRun run={run} label="Stop" /> : null}
          </>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-(--space-s)">
        <p className="min-w-0 flex-1">{approval.plain}</p>
        {outcome ? null : <Tag tone="warning">Auto-deny {approval.autoDeny}</Tag>}
      </div>

      <Collapsible.Root className="w-full">
        <Collapsible.Trigger className="flex items-center gap-(--space-xs) rounded-(--radius-xs) type-s weight-medium focus-ring">
          Show the exact command
          <Collapsible.Indicator>
            <ThemedIcon name="chevronRight" />
          </Collapsible.Indicator>
        </Collapsible.Trigger>
        <Collapsible.Panel>
          <Collapsible.Content>
            <ProofBlock className="mt-(--space-xs)">
              <span>{approval.raw}</span>
            </ProofBlock>
          </Collapsible.Content>
        </Collapsible.Panel>
      </Collapsible.Root>

      <KeyValues
        rows={[
          ["Target", approval.target],
          ["Tier", `${approval.tier}, ${TIER_WORD[approval.tier].toLowerCase()}`],
          ["Rule", `${approval.ruleId}: ${approval.rule}`],
          ["Impact", approval.impact],
          ["Rollback", approval.rollback],
        ]}
      />
      <Muted>
        Judge ({judgeModel}): {approval.judge}
      </Muted>
    </CardFrame>
  )
}

/* ---------- Run progress ---------- */

/** A run in flight: step, agents, models, spend, isolation, hosts. id: "131". */
export function RunProgressCard({ id }: { id: string }) {
  const run = useRun(id)
  if (!run) return <MissingCard kind="run" id={id} />
  const tone: DotTone =
    run.status === "done" ? "success" : run.status === "stopped" ? "muted" : run.waiting ? "warning" : "accent"
  const percent = Math.round((run.step / run.steps.length) * 100)

  return (
    <CardFrame
      title={`Run #${run.id}: ${run.title}`}
      tone={tone}
      meta={`Run mode: ${run.runMode} · Grant ${run.grantVersion}`}
    >
      <div className="flex items-center gap-(--space-xs)">
        <Dot tone={tone} />
        <span className="weight-medium">{run.waiting ?? RUN_STATUS[run.status]}</span>
      </div>

      <Progress.Root value={percent} className="w-full">
        <Progress.Heading>
          <Progress.Label>
            Step {run.step} of {run.steps.length}
          </Progress.Label>
          <Progress.Value />
        </Progress.Heading>
        <Progress.Track>
          <Progress.Indicator />
        </Progress.Track>
      </Progress.Root>

      <Meter.Root
        value={money(run.spend.spent)}
        max={money(run.spend.quote)}
        format={{ style: "currency", currency: "USD" }}
        className="w-full"
      >
        <Meter.Heading>
          <Meter.Label>Spend, this run</Meter.Label>
          <Meter.Value />
        </Meter.Heading>
        <Meter.Track>
          <Meter.Indicator />
        </Meter.Track>
      </Meter.Root>
      <Muted className="type-xs">Quote {run.spend.quote}.</Muted>

      <div className="flex flex-col gap-(--space-xs)">
        <Muted className="type-xs">Agents</Muted>
        <ul className="flex flex-col gap-(--space-xxs)">
          {run.agents.map((agent) => (
            <li key={agent.name} className="flex flex-wrap items-center gap-(--space-s)">
              <span className="font-data">{agent.name}</span>
              <Muted>{agent.role}</Muted>
              <Tag>{MODEL_SHORT[agent.model] ?? agent.model}</Tag>
              <span className="min-w-0 flex-1 truncate">{agent.state}</span>
              <span className="font-data text-(--cte-text-muted)">{agent.spend}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-(--space-xxs)">
        <Muted className="type-xs">Models used</Muted>
        <div className="flex flex-wrap gap-(--space-xs)">
          {run.modelsUsed.map((used) => (
            <Tag key={used.role}>
              {used.role}: {MODEL_SHORT[used.model] ?? used.model}
            </Tag>
          ))}
        </div>
      </div>

      <KeyValues
        rows={[
          ["Isolation", run.isolation],
          ["Self-test", `${run.selfTest.result}, ${run.selfTest.passed} of ${run.selfTest.of}, at ${run.selfTest.at}`],
          ["Setup window", run.setupWindow === "closed" ? "Closed. No more downloads." : "Open."],
          ["Slots", run.slot ? `${run.slot.share} of ${SLOTS.shared} model slots` : "Not using a shared slot"],
        ]}
      />

      <div className="flex flex-col gap-(--space-xs)">
        <Muted className="type-xs">Outside hosts contacted</Muted>
        {run.outsideHosts.length ? (
          <ul className="flex flex-col gap-(--space-xxs)">
            {run.outsideHosts.map((host) => (
              <li key={host.host} className="flex flex-wrap items-center gap-(--space-s)">
                <span>{host.host}</span>
                <Muted>{host.via}</Muted>
                {host.header ? <Tag>tagged</Tag> : null}
              </li>
            ))}
          </ul>
        ) : (
          <Muted>None.</Muted>
        )}
      </div>

      <PanelLink view={`run/${run.id}`}>Open run #{run.id}</PanelLink>
    </CardFrame>
  )
}

/* ---------- Result ---------- */

/** A finished run: rows by diff mark, drift, and the cleanup you must do. id: "129". */
export function ResultCard({ id }: { id: string }) {
  const run = useRun(id)
  const findings = useFindings()
  if (!run) return <MissingCard kind="run" id={id} />
  if (!run.result) {
    return <CardFrame title={`Run #${run.id} has no result yet`} tone="muted" meta={run.waiting ?? RUN_STATUS[run.status]} />
  }
  const result = run.result
  const yourCleanup = run.cleanup.filter((task) => task.who === "you")
  const drift = ASSETS.filter(
    (asset) =>
      asset.drift &&
      result.rows.some((row) => findings.some((finding) => finding.id === row.finding && finding.asset === asset.id)),
  )
  // Disclose the worst finding that is still open in this result. The harness
  // only drafts; a human sends. (drafts.tsx.)
  const rowFindings = new Set(result.rows.map((row) => row.finding).filter(Boolean))
  const worstOpen = openFindings(findings).find((finding) => rowFindings.has(finding.id))

  return (
    <CardFrame
      title={`Run #${run.id} result: ${run.title}`}
      tone="success"
      meta={`${run.trigger} · ${run.duration}`}
      actions={
        <>
          <ReportDraftDialog variant="secondary" />
          {worstOpen ? <DisclosureDraftDialog findingId={worstOpen.id} variant="outline" /> : null}
        </>
      }
    >
      <p>{result.summary}</p>

      <ul className="flex flex-col gap-(--space-xs)">
        {result.rows.map((row, index) => (
          <li key={index} className="flex flex-wrap items-center gap-(--space-s)">
            <span className="inline-flex items-center gap-(--space-xxs)">
              <Dot tone={MARK_TONE[row.mark]} />
              <span className="font-data" aria-hidden="true">
                {DIFF_SIGN[row.mark]}
              </span>
              <span>{row.mark}</span>
            </span>
            {row.finding ? (
              <PanelLink view={`finding/${row.finding}`} className="font-data">
                {row.finding}
              </PanelLink>
            ) : null}
            <span className="min-w-0 flex-1">{row.text}</span>
          </li>
        ))}
      </ul>

      {drift.length ? (
        <div className="flex flex-col gap-(--space-xxs)">
          <Muted className="type-xs">Drift</Muted>
          {drift.map((asset) => (
            <span key={asset.id}>
              {asset.name}: {asset.drift}
            </span>
          ))}
        </div>
      ) : null}

      {yourCleanup.length ? (
        <div className="flex flex-col gap-(--space-xs)">
          <Muted className="type-xs">Cleanup you must do</Muted>
          <ul className="flex flex-col gap-(--space-xxs)">
            {yourCleanup.map((task, index) => (
              <li key={index} className="flex items-center gap-(--space-xs)">
                <Dot tone={task.done ? "success" : "warning"} />
                <span className={task.done ? "text-(--cte-text-muted) line-through" : ""}>{task.text}</span>
                {task.done ? <Muted className="ml-auto">done</Muted> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <PanelLink view={`run/${run.id}`}>Open run #{run.id}</PanelLink>
    </CardFrame>
  )
}

/* ---------- Finding ---------- */

/** One finding. Verdict stays "Proven (machine)" until you accept it (B5). id: "F-0042". */
export function FindingCard({ id }: { id: string }) {
  const finding = useFinding(id)
  if (!finding) return <MissingCard kind="finding" id={id} />
  const asset = assetById(finding.asset)

  return (
    <CardFrame
      title={`${finding.id} ${finding.title}`}
      tone={SEVERITY_TONE[finding.severity]}
      meta={`${moduleByKey(finding.module)?.name ?? finding.module} · found ${finding.found}`}
    >
      <div className="flex flex-wrap items-center gap-(--space-s)">
        <SeverityLabel severity={finding.severity} />
        <Tag tone={VERDICT_TONE[verdictOf(finding)]}>{verdictLabel(finding)}</Tag>
        <Tag>{finding.access} access</Tag>
        {asset?.limited ? <Tag>Limited</Tag> : null}
      </div>
      <p>{finding.why}</p>
      <KeyValues
        rows={[
          ["Access", asset ? `${finding.access} access, ${asset.name}` : `${finding.access} access`],
          ["Inputs", finding.inputs.join(", ")],
          ["Cap", `${finding.cap}. ${finding.capReason}`],
        ]}
      />
      {asset?.limited ? <Muted>{NEAR_LIMITED}</Muted> : null}
      <PanelLink view={`finding/${finding.id}`}>Open {finding.id}</PanelLink>
    </CardFrame>
  )
}
