import { useState, type ReactNode } from "react"
import { Button, SelectField, Switch, ThemedIcon, Toast } from "@graphical"
import { Dot, KeyValues, Muted, Page, Section, Table, Tag, TextLink } from "@/components/app/blocks"
import { AUTOMATION_STATE, AUTOMATION_TONE, type DotTone } from "@/lib/tones"
import {
  ASSETS,
  AUTOMATIONS,
  GRANT,
  IN_SCOPE,
  LIVE_RUNS,
  MODELS,
  MODULES,
  NOTIFY,
  ORG,
  PROJECT,
  READY_CHECKS,
  SANDBOX,
  type Automation,
  type ModuleKey,
} from "@/data/fixtures"
import { liveRuns, useActions } from "@/lib/actions"

/*
 * Automations. The list and the selected automation share one page.
 * Weekly deep is selected. It missed 2 runs because the ready check found a
 * target down. Only the on switch and the schedule are editable here. Bound
 * items need re-approval, so they stay static text.
 *
 * Decisions applied here: every run is in a sandbox (2); one approval per
 * active step, scheduled runs never auto-approve (4); keep "Models used" (5);
 * the harness drafts a disclosure, a human sends it (9); no person's name
 * on a run, an approval or an alert (11).
 */

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Missing fixture: ${what}`)
  return value
}

const WEEKLY = must(
  AUTOMATIONS.find((automation) => automation.name === "Weekly deep"),
  "Weekly deep",
)
/** The target that was down at both missed fires. */
const DOWN_TARGET = must(
  ASSETS.find((asset) => asset.kind === "Web app"),
  "web app",
).name

/** Run now takes the next run number after the live runs. */
const NEXT_RUN_ID = Math.max(...LIVE_RUNS.map((run) => run.id)) + 1

const dollars = (value: string) => Number(value.replace("$", ""))
const LEFT_TODAY = `$${(dollars(ORG.spendCap) - dollars(ORG.spendToday)).toFixed(2)}`

/** Screen-only facts. The fixtures do not have them yet. */
const NOW = "09:30"
const PLAYBOOK = "weekly-deep (SKILL.md v2)"
const PRICE_BAND = "$5 to $20"
const BUDGET_CAP = "$6.00"
/** Bound at approval. No person's name (decision 11). */
const BOUND = { on: "Oct 9" }

/** The modules each automation runs. Keys from MODULES. */
const MODULES_BY_AUTOMATION: Record<string, ModuleKey[]> = {
  "Morning check": ["surface", "web", "apis", "domains", "people"],
  "Deploy check": ["web", "apis", "supply"],
  "Weekly deep": ["contracts", "keys", "web", "apis", "domains", "supply"],
  "Chain watch": ["chain-watch", "keys"],
  "Monthly drill": ["readiness", "surface"],
}

function modulesOf(name: string) {
  const keys = MODULES_BY_AUTOMATION[name] ?? []
  return MODULES.filter((module) => keys.includes(module.key))
}

const WEEKLY_MODULES = modulesOf(WEEKLY.name)

/** Next fire of the other automations. Weekly deep's comes from its schedule. */
const NEXT_RUN: Record<string, string> = {
  "Morning check": "Mon Nov 9, 06:00",
  "Deploy check": "On the next deploy",
  "Chain watch": "Every block",
  "Monthly drill": "None while off",
}

type Fire = { when: string; afterGrant: boolean }

/** The first `allowed` fires fall before the grant ends. The rest are blocked. */
function fires(days: string[], time: string, allowed: number): Fire[] {
  return days.map((day, index) => ({ when: `${day}, ${time}`, afterGrant: index >= allowed }))
}

/** Times are UTC. The schedule is not a bound item. */
const SCHEDULES = [
  {
    value: "sat-0200",
    label: WEEKLY.trigger,
    fires: fires(["Sat Nov 14", "Sat Nov 21", "Sat Nov 28", "Sat Dec 5", "Sat Dec 12"], "02:00", 3),
  },
  {
    value: "sat-0400",
    label: "Saturdays at 04:00",
    fires: fires(["Sat Nov 14", "Sat Nov 21", "Sat Nov 28", "Sat Dec 5", "Sat Dec 12"], "04:00", 3),
  },
  {
    value: "sun-0400",
    label: "Sundays at 04:00",
    fires: fires(["Sun Nov 15", "Sun Nov 22", "Sun Nov 29", "Sun Dec 6", "Sun Dec 13"], "04:00", 2),
  },
  {
    value: "mon-0100",
    label: "Mondays at 01:00",
    fires: fires(["Mon Nov 9", "Mon Nov 16", "Mon Nov 23", "Mon Nov 30", "Mon Dec 7"], "01:00", 3),
  },
]

type HistoryRow = {
  key: string
  run?: number
  fired: string
  result: string
  tone: DotTone
  cost: string
  changes: string
}

/** A blocked fire never starts a run, so it has no run number. */
const HISTORY: HistoryRow[] = [
  {
    key: "nov-7",
    fired: "Sat Nov 7, 02:00",
    result: `Blocked: ${DOWN_TARGET} down`,
    tone: "error",
    cost: "$0.00",
    changes: "Not run. Not counted as fixed.",
  },
  {
    key: "oct-31",
    fired: "Sat Oct 31, 02:00",
    result: `Blocked: ${DOWN_TARGET} down`,
    tone: "error",
    cost: "$0.00",
    changes: "Not run. Not counted as fixed.",
  },
  {
    key: "118",
    run: 118,
    fired: "Sat Oct 24, 02:00",
    result: "Succeeded with gaps: hit the budget cap",
    tone: "warning",
    cost: "$6.00",
    changes: "+1 new, -1 fixed, 1 not run",
  },
  {
    key: "104",
    run: 104,
    fired: "Sat Oct 17, 02:00",
    result: "Succeeded",
    tone: "success",
    cost: "$5.41",
    changes: "+2 new, 9 still open",
  },
  {
    key: "91",
    run: 91,
    fired: "Sat Oct 10, 02:00",
    result: "Succeeded",
    tone: "success",
    cost: "$5.87",
    changes: "+1 new, 8 still open",
  },
]

/**
 * Notes for the 13-item ready check. Keyed by the fixture's check number.
 * The labels come from READY_CHECKS, so decisions 2, 4 and 5 are already in:
 * check 6 "Notification route works", check 8 "NEAR AI models answer",
 * check 12 "Network rules hold", check 13 "Sandbox self-test passed".
 */
const PROVEN = IN_SCOPE.filter((asset) => asset.proof.ok).length

const READY_NOTE: Record<number, ReactNode> = {
  1: `Grant ${GRANT.version}, ends ${GRANT.ends}`,
  2: <span className="font-data">{GRANT.scopeHash}</span>,
  3: `${PROVEN} of ${IN_SCOPE.length} proven. ${IN_SCOPE.length - PROVEN} wait for proof.`,
  4: GRANT.window,
  5: `${WEEKLY.runMode}. The grant allows up to ${GRANT.ceiling}.`,
  6: "Telegram and the browser reach you.",
  7: `${LEFT_TODAY} left today. A run needs up to ${BUDGET_CAP}.`,
  8: "Checked 2 min ago. 2 models.",
  9: `${DOWN_TARGET} is up again`,
  10: "No change freeze set.",
  11: "RPC and API keys found.",
  12: "Sandbox egress and RPC proxy on.",
  13: `At ${SANDBOX.selfTest.at}`,
}

const HEALTH_RULES = [
  { plain: "Alert after 2 missed runs", term: "heartbeat: 2" },
  { plain: "One run at a time", term: "max_parallel: 1" },
  { plain: "A new fire replaces one that has not started", term: "cancel_superseded: on" },
  { plain: "Never starts another automation", term: "chains: none" },
]

/** A Dot that lines up with the first line of type-s text. */
function LineDot({ tone }: { tone: DotTone }) {
  return (
    <span className="flex h-(--line-s) shrink-0 items-center">
      <Dot tone={tone} />
    </span>
  )
}

function StateLabel({ state }: { state: Automation["state"] }) {
  return (
    <span className="inline-flex items-center gap-(--space-xs) whitespace-nowrap">
      <Dot tone={AUTOMATION_TONE[state]} />
      {AUTOMATION_STATE[state]}
    </span>
  )
}

/** The modules an automation runs, as links to each module's coverage. */
function ModuleLinks({ name }: { name: string }) {
  const modules = modulesOf(name)
  return (
    <span>
      {modules.map((module, index) => (
        <span key={module.key}>
          {index > 0 ? ", " : null}
          <TextLink panel={`coverage/${module.key}`}>{module.name}</TextLink>
        </span>
      ))}
    </span>
  )
}

/** A titled part inside the selected automation. Section only renders h2. */
function Part({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-(--space-s)">
      <div className="flex flex-col gap-(--space-xxs)">
        <h3 className="type-s weight-medium">{title}</h3>
        {note ? <Muted className="type-xs">{note}</Muted> : null}
      </div>
      {children}
    </section>
  )
}

export function AutomationsScreen() {
  const toasts = Toast.useToastManager()
  const running = liveRuns(useActions())
  const [on, setOn] = useState(true)
  const [scheduleValue, setScheduleValue] = useState(SCHEDULES[0].value)
  const schedule = must(
    SCHEDULES.find((option) => option.value === scheduleValue),
    "schedule",
  )
  const blocked = schedule.fires.filter((fire) => fire.afterGrant).length
  const weeklyState: Automation["state"] = on ? WEEKLY.state : "off"

  const runNow = () =>
    toasts.add({
      title: `${WEEKLY.name} started as run #${NEXT_RUN_ID}`,
      description: `The ready check passed ${READY_CHECKS.length} of ${READY_CHECKS.length}. An active step waits for your approval. The run reports into the chat.`,
    })

  const edit = () =>
    toasts.add({
      title: `Edit ${WEEKLY.name}`,
      description: "A change to a bound item sets Needs re-approval. The schedule is not bound.",
    })

  return (
    <Page
      crumbs={[{ label: PROJECT.name, to: "home" }, { label: "Automations" }]}
      title="Automations"
      meta={
        <>
          <span>{AUTOMATIONS.length} automations</span>
          <span>{AUTOMATIONS.filter((automation) => automation.state === "running").length} running</span>
          <span>{AUTOMATIONS.filter((automation) => automation.state === "failed").length} failed</span>
          <span>Ceiling: {GRANT.ceiling}</span>
        </>
      }
      rail={
        <>
          <Section title="Ready check" count={`${READY_CHECKS.length} of ${READY_CHECKS.length}`}>
            <Muted className="type-xs">
              For {WEEKLY.name}, run again at {NOW}. It runs in the sandbox before every fire. A failed
              item blocks the run.
            </Muted>
            <ol className="flex flex-col gap-(--space-s) type-s">
              {READY_CHECKS.map((item) => (
                <li key={item.n} className="flex items-start gap-(--space-xs)">
                  <span className="w-(--space-l) shrink-0 font-data tabular-nums type-xs leading-(--line-s) text-(--cte-text-muted)">
                    {item.n}
                  </span>
                  <LineDot tone={item.ok ? "success" : "error"} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span>{item.label}</span>
                    <span className="type-xs text-(--cte-text-muted)">{READY_NOTE[item.n]}</span>
                  </span>
                  <span className="shrink-0 type-xs leading-(--line-s)">{item.ok ? "ok" : "fail"}</span>
                </li>
              ))}
            </ol>
          </Section>

          <Section title="Health rules">
            <ul className="flex flex-col gap-(--space-s) type-s">
              {HEALTH_RULES.map((rule) => (
                <li key={rule.term} className="flex flex-col">
                  <span>{rule.plain}</span>
                  <span className="font-data type-xs text-(--cte-text-muted)">{rule.term}</span>
                </li>
              ))}
            </ul>
          </Section>
        </>
      }
    >
      <Section title="How automations run">
        <KeyValues
          rows={[
            [
              "Reports to",
              "The chat. Every automation reports each run into the agent chat.",
            ],
            [
              "Approvals",
              "Scheduled runs never auto-approve. An active step waits for you. One approval per step. No yes to all.",
            ],
            [
              "Run mode",
              `No automation runs above the grant ceiling, ${GRANT.ceiling}.`,
            ],
            [
              "Sandbox",
              `Every run happens in a sandbox (${SANDBOX.provider}). ${SANDBOX.downRule}`,
            ],
            [
              "Disclosures",
              "The harness never sends a disclosure. It drafts one, and you send it.",
            ],
          ]}
        />
      </Section>

      <Section title="All automations" count={AUTOMATIONS.length}>
        <Table
          head={["Name", "State", "Run mode", "Trigger", "Last result", "Next run"]}
          rows={AUTOMATIONS.map((automation) => {
            const selected = automation.name === WEEKLY.name
            const live = running.find((run) => run.label === automation.name)
            const next = selected
              ? on
                ? schedule.fires[0].when
                : "None while off"
              : NEXT_RUN[automation.name]
            return {
              key: automation.name,
              cells: [
                <span key="name" aria-current={selected ? "true" : undefined} className="flex min-w-0 flex-col gap-(--space-xxs)">
                  <span className="weight-medium">{automation.name}</span>
                  <span className="type-xs text-(--cte-text-muted)">
                    Runs <ModuleLinks name={automation.name} />
                  </span>
                  {selected ? <Muted className="type-xs">Shown below</Muted> : null}
                </span>,
                <StateLabel key="state" state={selected ? weeklyState : automation.state} />,
                <span key="mode">{automation.runMode}</span>,
                automation.trigger,
                <span key="last" className="flex flex-col">
                  <span>{automation.lastResult}</span>
                  {live ? (
                    <Muted className="type-xs">
                      <TextLink panel={`run/${live.id}`}>Run #{live.id}</TextLink>, {live.project}
                    </Muted>
                  ) : null}
                </span>,
                <span key="next" className="font-data">
                  {next}
                </span>,
              ],
            }
          })}
        />
      </Section>

      <section
        aria-labelledby="selected-automation"
        className="flex flex-col gap-(--space-xl) pt-(--space-xl) divide-top"
      >
        <div className="flex flex-wrap items-center gap-(--space-m)">
          <div className="flex min-w-0 flex-col gap-(--space-xxs)">
            <div className="flex items-center gap-(--space-s)">
              <h2 id="selected-automation" className="type-m weight-medium">
                {WEEKLY.name}
              </h2>
              <Tag tone={AUTOMATION_TONE[weeklyState]}>{AUTOMATION_STATE[weeklyState]}</Tag>
            </div>
            <span className="type-s text-(--cte-text-muted)">
              Runs on <TextLink to="scope">{PROJECT.name}</TextLink>. Playbook{" "}
              <span className="font-data">{PLAYBOOK}</span>. Reports into the chat.
            </span>
          </div>
          <div className="ml-auto flex items-center gap-(--space-m)">
            <Switch.Row>
              <Switch.Root checked={on} onCheckedChange={(checked) => setOn(checked)}>
                <Switch.Thumb />
              </Switch.Root>
              <Switch.Label>Run on schedule</Switch.Label>
            </Switch.Row>
            <Button variant="secondary" onClick={edit}>
              <ThemedIcon name="pencil" />
              Edit
            </Button>
            <Button onClick={runNow}>
              <ThemedIcon name="play" />
              Run now
            </Button>
          </div>
        </div>

        <section
          aria-labelledby="why-it-failed"
          className="flex flex-col gap-(--space-s) rounded-(--radius-m) bg-(--cte-surface-muted) p-(--space-m) type-s"
        >
          <h3 id="why-it-failed" className="flex items-center gap-(--space-xs) weight-medium">
            <Dot tone="error" />
            Why it failed: {WEEKLY.lastResult}
          </h3>
          <p>
            The runs at 02:00 on Oct 31 and Nov 7 did not start. Both times, the ready check found{" "}
            <span className="font-data">{DOWN_TARGET}</span> down (HTTP 503). A run does not start
            when a target is down.
          </p>
          <p>
            Nothing was tested on those days, so nothing counts as passed or fixed. The 06:00 Morning
            check reached <span className="font-data">{DOWN_TARGET}</span> on both days.
          </p>
          <p>
            What to do: select Run now to catch up. The ready check passes now. Then move the schedule
            away from 02:00.
          </p>
        </section>

        <div className="grid grid-cols-2 gap-(--space-xl)">
          <Part title="Schedule" note="Times are UTC. The schedule is not bound, so a change needs no re-approval.">
            <SelectField
              label="Runs"
              options={SCHEDULES.map(({ value, label }) => ({ value, label }))}
              value={scheduleValue}
              onValueChange={(value) => {
                if (value) setScheduleValue(value)
              }}
            />
            {on ? (
              <>
                <span className="type-xs text-(--cte-text-muted)">Next 5 runs</span>
                <ol className="flex flex-col gap-(--space-xxs) type-s">
                  {schedule.fires.map((fire) => (
                    <li key={fire.when} className="flex items-center gap-(--space-s)">
                      <span className="font-data">{fire.when}</span>
                      {fire.afterGrant ? (
                        <span className="ml-auto inline-flex items-center gap-(--space-xs)">
                          <Dot tone="error" />
                          Blocked: after the grant ends
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
                <p className="flex items-start gap-(--space-xs) type-s">
                  <LineDot tone="warning" />
                  <span>
                    Grant {GRANT.version} ends {GRANT.expires}, on {GRANT.ends}. {blocked} of the next 5
                    runs fall after it. <TextLink to="scope">Renew it in Scope</TextLink>
                  </span>
                </p>
              </>
            ) : (
              <Muted className="type-s">Turned off. No runs are planned.</Muted>
            )}
          </Part>

          <Part title="What it runs">
            <KeyValues
              rows={[
                [
                  "Modules",
                  <span key="modules">
                    {WEEKLY_MODULES.map((module, index) => (
                      <span key={module.key}>
                        {index > 0 ? ", " : null}
                        <TextLink panel={`coverage/${module.key}`}>{module.name}</TextLink>
                      </span>
                    ))}
                  </span>,
                ],
                [
                  "Run mode",
                  `${WEEKLY.runMode}. The riskiest steps run only on a copy of the chain. The grant ceiling is ${GRANT.ceiling}.`,
                ],
                [
                  "Approvals",
                  "Never automatic. An active step waits for you. One approval per step.",
                ],
                ["Reports to", "The chat, and your notification routes."],
                ["Usual cost", `${PRICE_BAND} a run`],
              ]}
            />
          </Part>

          <Part
            title="Bound at approval"
            note={`Approved on ${BOUND.on}. A change to any item here sets Needs re-approval.`}
          >
            <KeyValues
              rows={[
                ["Permission", <TextLink key="permission" to="scope">Grant {GRANT.version}</TextLink>],
                ["Scope", <span key="scope" className="font-data">{GRANT.scopeHash}</span>],
                ["Run mode", WEEKLY.runMode],
                [
                  "Models used",
                  <ul key="models" className="flex flex-col">
                    {MODELS.map((model) => (
                      <li key={model.role}>
                        {model.role}: <span className="font-data">{model.model}</span>
                      </li>
                    ))}
                  </ul>,
                ],
                [
                  "Budget cap",
                  <span key="budget">
                    <span className="font-data">{BUDGET_CAP}</span> a run. The run stops at the cap and
                    lists what it did not reach.
                  </span>,
                ],
              ]}
            />
          </Part>

          <Part title="Who gets told" note="A route, never a person. No name on an alert.">
            <KeyValues
              rows={NOTIFY.map((route) => [
                <span key={route.route} className="inline-flex items-center gap-(--space-xs)">
                  <Dot tone={route.on ? "success" : "muted"} />
                  {route.route}
                </span>,
                <span key={`${route.route}-what`}>
                  {route.on ? route.what : <Muted>{route.what}</Muted>}
                </span>,
              ])}
            />
            <p className="flex items-start gap-(--space-xs) type-s">
              <LineDot tone="warning" />
              <span>Missed-run alert sent on Telegram, Nov 7 at 02:00.</span>
            </p>
          </Part>
        </div>

        <Part title="History" note="Most recent first. A blocked fire does not start a run.">
          <Table
            head={["Run", "Fired", "Result", "Cost", "Changes"]}
            rows={HISTORY.map((row) => ({
              key: row.key,
              cells: [
                row.run ? (
                  <span key="run" className="font-data tabular-nums">
                    #{row.run}
                  </span>
                ) : (
                  <Muted key="run">Not started</Muted>
                ),
                <span key="fired" className="font-data tabular-nums whitespace-nowrap">
                  {row.fired}
                </span>,
                <span key="result" className="inline-flex items-center gap-(--space-xs)">
                  <Dot tone={row.tone} />
                  {row.result}
                </span>,
                <span key="cost" className="font-data tabular-nums">
                  {row.cost}
                </span>,
                <span key="changes" className="font-data tabular-nums">
                  {row.changes}
                </span>,
              ],
            }))}
          />
        </Part>
      </section>
    </Page>
  )
}
