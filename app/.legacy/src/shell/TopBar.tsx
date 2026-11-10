import { AlertDialog, Button, Popover, ThemedIcon, Toast } from "@graphical"
import { Dot, Tag, type DotTone } from "@/components/app/blocks"
import { FIRST_RUN_BAR, HEALTH, ORG, PROJECT, SCOPE_PROPOSALS, STOP_ALL, type HealthRow } from "@/data/fixtures"
import { liveRuns, needsYou, spendToday, stopLive, useActions } from "@/lib/actions"
import { accessMix } from "@/lib/answer"
import { href, useRoute } from "@/lib/route"

/*
 * The top bar. One row across the app.
 * - "Ceiling: Prove" is the highest run mode the grant allows. Never bare "Mode".
 * - First run shows "Run mode: Observe" the whole time (A9, A10).
 *   It says "No scope yet" until you confirm the scope proposal.
 * - Needs you, spend and Stop all read the shared store (lib/actions.ts).
 * - STOP ALL asks first and names what it cuts. The scope proxy is first.
 */

const FIRST_RUN_PROPOSAL = SCOPE_PROPOSALS["first-run"]

const HEALTH_TONE: Record<HealthRow["tone"], DotTone> = { ok: "success", warn: "warning", fail: "error" }

function worstHealth(): HealthRow["tone"] {
  if (HEALTH.some((row) => row.tone === "fail")) return "fail"
  if (HEALTH.some((row) => row.tone === "warn")) return "warn"
  return "ok"
}

export function TopBar() {
  const route = useRoute()
  const actions = useActions()
  const firstRun = route === "first-run"
  const live = !firstRun && liveRuns(actions).length > 0
  const scoped = firstRun && FIRST_RUN_PROPOSAL ? actions.confirmed.includes(FIRST_RUN_PROPOSAL.id) : false
  const today = firstRun ? FIRST_RUN_BAR.spendToday : spendToday(actions)
  const scopeText = !firstRun
    ? accessMix()
    : scoped && FIRST_RUN_PROPOSAL
      ? `Scope ${FIRST_RUN_PROPOSAL.version} · ${accessMix(FIRST_RUN_PROPOSAL.assets)}`
      : "No scope yet"

  return (
    <header className="flex min-w-0 shrink-0 items-center gap-(--space-m) bg-(--cte-surface) px-(--space-m) py-(--space-xs) divide-bottom">
      <span className="truncate type-s weight-medium">{PROJECT.name}</span>
      <span className="type-xs text-(--cte-text-muted)">{scopeText}</span>
      {firstRun ? (
        <Tag>Run mode: {FIRST_RUN_BAR.runMode}</Tag>
      ) : (
        <Tag>Ceiling: {PROJECT.ceiling}</Tag>
      )}

      <div className="ml-auto flex items-center gap-(--space-s)">
        <NeedsYou firstRun={firstRun} scoped={scoped} />
        <Spend today={today} />
        <Health />
        <StopAll firstRun={firstRun} live={live} />
      </div>
    </header>
  )
}

/** Before a scope exists, the one thing that needs you is the scope proposal. */
const FIRST_RUN_NEEDS = [{ id: "scope", text: "Confirm or edit the scope proposal", to: href("first-run"), note: "Nothing is tested until you confirm." }]

function NeedsYou({ firstRun, scoped }: { firstRun: boolean; scoped: boolean }) {
  const actions = useActions()
  const items = firstRun
    ? scoped
      ? []
      : FIRST_RUN_NEEDS.slice(0, FIRST_RUN_BAR.needsYou)
    : needsYou(actions).map((item) => ({
        id: item.id,
        text: item.text,
        to: href("home", item.panel),
        note: `Auto-deny at ${item.autoDeny}`,
      }))
  return (
    <Popover.Root>
      <Popover.Trigger render={<Button variant="ghost" />}>
        Needs you <span className="font-data">{items.length}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="end">
          <Popover.Popup>
            <Popover.Title>Needs you</Popover.Title>
            {items.length ? null : <Popover.Description>Nothing needs you now.</Popover.Description>}
            <ul className="flex flex-col gap-(--space-xs) type-s">
              {items.map((item) => (
                <li key={item.id} className="flex flex-col">
                  <Popover.Close
                    nativeButton={false}
                    render={<a href={item.to} />}
                    className="rounded-(--radius-xs) text-left underline-offset-2 hover:underline focus-ring"
                  >
                    {item.text}
                  </Popover.Close>
                  <span className="type-xs text-(--cte-text-muted)">{item.note}</span>
                </li>
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function Spend({ today }: { today: string }) {
  return (
    <Popover.Root>
      <Popover.Trigger render={<Button variant="ghost" />}>
        <span className="font-data tabular-nums">
          {today} of {ORG.spendCap}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="end">
          <Popover.Popup>
            <Popover.Title>
              {today} of {ORG.spendCap} today
            </Popover.Title>
            <Popover.Description>
              {ORG.spendMonth} of {ORG.spendMonthCap} this month. Runs pause at the cap. Change it in Settings.
            </Popover.Description>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function Health() {
  const worst = worstHealth()
  const label = worst === "ok" ? "Health ok" : worst === "warn" ? "Health: check" : "Health: problem"
  // Failures first, so a problem is never below the fold.
  const rows = [...HEALTH].sort((a, b) => order(a.tone) - order(b.tone))
  return (
    <Popover.Root>
      <Popover.Trigger render={<Button variant="ghost" />}>
        <Dot tone={HEALTH_TONE[worst]} />
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="end">
          <Popover.Popup>
            <Popover.Title>Harness health</Popover.Title>
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-(--space-m) gap-y-(--space-xxs) type-s">
              {rows.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="flex items-center gap-(--space-xs)">
                    <Dot tone={HEALTH_TONE[row.tone]} />
                    {row.label}
                  </dt>
                  <dd className="text-(--cte-text-muted)">{row.value}</dd>
                </div>
              ))}
            </dl>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function order(tone: HealthRow["tone"]) {
  return tone === "fail" ? 0 : tone === "warn" ? 1 : 2
}

function StopAll({ firstRun, live }: { firstRun: boolean; live: boolean }) {
  const toasts = Toast.useToastManager()

  function stop() {
    if (!firstRun && stopLive()) {
      toasts.add({
        title: "Stopped all runs",
        description: "Scope proxy cut first. Evidence up to the last step is kept. The Home chat lists what to check.",
      })
      return
    }
    toasts.add({
      title: "No run is live",
      description: firstRun ? "Plan 1 has not started. Nothing reaches a target." : "Every run has ended. Nothing reaches a target.",
    })
  }

  return (
    <AlertDialog.Root>
      {/* Quiet until a run is live: red is reserved for a control that can cut
          something running right now, never as persistent chrome. */}
      <AlertDialog.Trigger render={<Button variant={live ? "danger" : "outline"} />}>Stop all</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop />
        <AlertDialog.Popup>
          <AlertDialog.Title>{STOP_ALL.title}</AlertDialog.Title>
          <AlertDialog.Description>{STOP_ALL.body}</AlertDialog.Description>
          <ol className="flex list-decimal flex-col gap-(--space-xxs) pl-(--space-l) type-s">
            {STOP_ALL.cuts.map((cut) => (
              <li key={cut}>{cut}</li>
            ))}
          </ol>
          <div className="flex justify-end gap-(--space-s)">
            <AlertDialog.Close>Keep running</AlertDialog.Close>
            <AlertDialog.Close
              render={<Button variant="danger" />}
              onClick={stop}
            >
              Stop all
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

/** Renders queued toasts. Lives once in the shell. */
export function Toaster() {
  const { toasts } = Toast.useToastManager()
  return (
    <Toast.Portal>
      <Toast.Viewport>
        {toasts.map((toast) => (
          <Toast.Root key={toast.id} toast={toast}>
            <Toast.Content>
              <Toast.Title />
              <Toast.Description />
              <Toast.Close aria-label="Dismiss">
                <ThemedIcon name="close" />
              </Toast.Close>
            </Toast.Content>
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  )
}
