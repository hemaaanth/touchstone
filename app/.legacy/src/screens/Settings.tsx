import { Meter, Switch } from "@graphical"
import { Dot, KeyValues, Muted, Page, Section, Tag, type DotTone } from "@/components/app/blocks"
import {
  AUDIT,
  GRANT,
  HEALTH,
  MODELS,
  NOTIFY,
  ORG,
  PROJECT,
  RETENTION,
  SANDBOX,
  SEARCH,
  SLOTS,
  type HealthRow,
} from "@/data/fixtures"
import { useWords } from "@/lib/words"

/*
 * Settings: models, sandbox, budgets, notifications, words, harness health,
 * retention and the audit log head.
 *
 * One user. No members, no roles, no attestation (decisions 5 and 11). Every
 * value reads a fixture; nothing here calls a backend.
 */

const HEALTH_TONE: Record<HealthRow["tone"], DotTone> = {
  ok: "success",
  warn: "warning",
  fail: "error",
}

/** The shared pool held by running jobs right now. */
const SHARED_IN_USE = SLOTS.jobs.reduce((total, job) => total + job.share, 0)

/** A $x.xx cap minus a $y.yy spend, as a string. */
const dollars = (value: string) => Number(value.replace("$", ""))
const BUDGET_PER_RUN = "$6.00"

export function Settings() {
  const { technical, setWords } = useWords()

  return (
    <Page crumbs={[{ label: PROJECT.name, to: "home" }]} title="Settings">
      <Section title="Models">
        <KeyValues
          rows={MODELS.map((model) => [
            model.role,
            <span key={model.role} className="flex flex-col">
              <span className="font-data">{model.model}</span>
              <Muted className="type-xs">
                {model.structured ? "Structured output" : "No structured output"}
              </Muted>
            </span>,
          ])}
        />
        <Muted className="type-s">
          Both models are abliterated. The judge is abliterated too, so every guardrail holds in code.
        </Muted>
        <Muted className="type-s">
          {SEARCH.mode}. Embeddings: {SEARCH.embeddings}.
        </Muted>

        <div className="flex flex-col gap-(--space-s) rounded-(--radius-m) bg-(--cte-surface-muted) p-(--space-m)">
          <Meter.Root value={SHARED_IN_USE} max={SLOTS.shared} className="w-full">
            <Meter.Heading>
              <Meter.Label>Shared job slots</Meter.Label>
              <span className="font-data type-xs text-(--cte-text-muted)">
                {SHARED_IN_USE} of {SLOTS.shared} in use
              </span>
            </Meter.Heading>
            <Meter.Track>
              <Meter.Indicator />
            </Meter.Track>
          </Meter.Root>
          <Muted className="type-xs">
            {SLOTS.total} model requests at once. {SLOTS.chat} stay for the chat. {SLOTS.shared} split
            evenly between running jobs. {SLOTS.note}
          </Muted>
          <Muted className="type-xs">
            When the pool is full, a run shows "{SLOTS.waitingModel}", never a silent stall.
          </Muted>
        </div>
      </Section>

      <Section title="Sandbox">
        <KeyValues
          rows={[
            ["Provider", SANDBOX.provider],
            ["Isolation", SANDBOX.isolation],
            [
              "Self-test",
              `${SANDBOX.selfTest.result} at ${SANDBOX.selfTest.at}: ${SANDBOX.selfTest.checks.join(", ")}.`,
            ],
            ["Scope proxy", `${SANDBOX.proxies.scope}, ${SANDBOX.proxies.rule.toLowerCase()}`],
            ["RPC proxy", `${SANDBOX.proxies.rpc}, blocks sign and send`],
            ["Sandboxes in use", SANDBOX.inUseLabel],
            ["Egress", SANDBOX.egressNote],
            ["Traffic", <span key="traffic" className="font-data">{SANDBOX.trafficHeader}</span>],
          ]}
        />
        <Muted className="type-s">{SANDBOX.hostNote}</Muted>
        <Muted className="type-s">{SANDBOX.downRule}</Muted>
        <div className="flex flex-col gap-(--space-xs)">
          <span className="type-xs text-(--cte-text-muted)">Drivers</span>
          <ul className="flex flex-col gap-(--space-xs) type-s">
            {SANDBOX.drivers.map((driver) => (
              <li key={driver.key} className="flex flex-wrap items-center gap-(--space-s)">
                <Dot tone={driver.current ? "success" : "muted"} />
                <span>{driver.label}</span>
                <span className="font-data type-xs text-(--cte-text-muted)">{driver.isolation}</span>
                <span className="ml-auto type-xs text-(--cte-text-muted)">
                  {driver.current ? "In use" : driver.note || "Not in this build"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section title="Budgets">
        <KeyValues
          rows={[
            ["Today", `${ORG.spendToday} of ${ORG.spendCap}. $${(dollars(ORG.spendCap) - dollars(ORG.spendToday)).toFixed(2)} left.`],
            ["This month", `${ORG.spendMonth} of ${ORG.spendMonthCap}`],
            ["Per run", `${BUDGET_PER_RUN}. A run stops at the cap and lists what it did not reach.`],
          ]}
        />
        <Muted className="type-s">At the cap, no new run starts. A running job finishes its step, then stops.</Muted>
      </Section>

      <Section title="Notifications">
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
        <Muted className="type-s">A route, never a person. No name on an alert (decision 11).</Muted>
      </Section>

      <Section title="Words">
        <Switch.Row>
          <Switch.Root
            checked={technical}
            onCheckedChange={(checked) => setWords(checked ? "technical" : "plain")}
          >
            <Switch.Thumb />
          </Switch.Root>
          <Switch.Label>Technical words</Switch.Label>
        </Switch.Row>
        <Muted className="type-s">
          Plain words are the default. Technical words show hashes and tiers. Exports always keep the
          technical words.
        </Muted>
      </Section>

      <Section title="Harness health">
        <ul className="flex flex-col gap-(--space-s) type-s">
          {HEALTH.map((row) => (
            <li key={row.label} className="flex items-start gap-(--space-s)">
              <span className="flex h-(--line-s) shrink-0 items-center">
                <Dot tone={HEALTH_TONE[row.tone]} />
              </span>
              <span className="min-w-0 flex-1">{row.label}</span>
              <span className="shrink-0 text-(--cte-text-muted)">{row.value}</span>
            </li>
          ))}
        </ul>
        <Muted className="type-s">If the PII filter fails, model calls stop and this list shows it.</Muted>
      </Section>

      <Section title="Retention">
        <KeyValues
          rows={[
            ["Traces and evidence", `Kept ${RETENTION.days} days, then deleted. Each deletion is logged.`],
            ["Last cleanup", `${RETENTION.lastCleanup}: ${RETENTION.lastDeleted}`],
            ["Audit log", RETENTION.auditLifetime],
          ]}
        />
      </Section>

      <Section title="Audit log" count={`entry ${AUDIT[0].n.toLocaleString()}`}>
        <Muted className="type-s">
          The audit log keeps only events and hashes. It is kept as long as this instance. Newest first.
        </Muted>
        <ul className="flex flex-col gap-(--space-s) type-s">
          {AUDIT.map((entry) => (
            <li key={entry.n} className="flex flex-col gap-(--space-xxs) divide-bottom pb-(--space-s)">
              <span className="flex flex-wrap items-center gap-(--space-s)">
                <span className="font-data tabular-nums type-xs text-(--cte-text-muted)">{entry.n.toLocaleString()}</span>
                <span className="font-data tabular-nums type-xs text-(--cte-text-muted)">{entry.at}</span>
                <span className="type-xs weight-medium">{entry.by}</span>
                {entry.deletion ? <Tag tone="muted">Deletion</Tag> : null}
              </span>
              <span>{entry.text}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Muted className="type-s">
        One user. Grant {GRANT.version} was confirmed by typing the project name.
      </Muted>
    </Page>
  )
}
