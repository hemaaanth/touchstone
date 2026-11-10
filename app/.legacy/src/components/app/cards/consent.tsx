import { useId, useState, type FormEvent, type ReactNode } from "react"
import { Button, Checkbox, Dialog, Input, InputLabel, Toast } from "@graphical"
import { Dot, KeyValues, Muted, Tag, TextLink, type DotTone } from "@/components/app/blocks"
import {
  BEFORE_PROOF,
  BLOCKED,
  PROOF_BY_KIND,
  RUNS,
  SCOPE_PROPOSALS,
  SETUP_NEEDED,
  STOPS,
  moduleByKey,
  type ProposedAsset,
  type ScopeChange,
  type ScopeProposal,
  type SetupRow,
  type StopInfo,
} from "@/data/fixtures"
import { confirmScope, useActions } from "@/lib/actions"
import { useWords } from "@/lib/words"
import { CardFrame, MissingCard, PanelLink } from "./frame"

/*
 * The consent and safety chat cards.
 * Every card takes { id } and reads its fixture.
 *   ScopeProposalCard  assets, access and why, proof, Never touch, hash, Confirm
 *   BlockedCard        what a rule or a missing input stopped, with the rule ID
 *   StopCard           what stopped, the cut order, what you must clean up
 *   SetupNeededCard    what is missing and how to add it. It never sends anything.
 * Words: "confirm", never "sign". Confirm approves no step (A2).
 */

/* ---------- Shared parts ---------- */

/** A small titled group inside a card body. */
function Part({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-(--space-xxs)">
      <h4 className="type-xs weight-medium text-(--cte-text-muted)">{title}</h4>
      {children}
    </div>
  )
}

const CHANGE_WORD: Record<ScopeChange["mark"], string> = { "+": "Added", "-": "Removed", "~": "Changed" }

/** A scope diff. "+" added, "-" removed, "~" changed. The Scope screen uses it too. */
export function ScopeChanges({ changes }: { changes: ScopeChange[] }) {
  return (
    <ul className="flex flex-col gap-(--space-xxs) type-s">
      {changes.map((change) => (
        <li key={`${change.mark}${change.item}`} className="flex gap-(--space-s)">
          <span aria-hidden="true" className="w-(--space-m) shrink-0 font-data tabular-nums text-(--cte-text-muted)">
            {change.mark}
          </span>
          <span className="min-w-0">
            <span className="sr-only">{CHANGE_WORD[change.mark]}: </span>
            <span className="weight-medium">{change.item}</span> <Muted>{change.detail}</Muted>
          </span>
        </li>
      ))}
    </ul>
  )
}

/* ---------- Scope proposal ---------- */

const BEFORE_PROOF_TECHNICAL = "P and F steps can run before proof. S and I steps wait for proof."

/**
 * Scope proposal. id: SCOPE_PROPOSALS key, "first-run".
 * Confirm goes to the shared store, so First run posts Plan 1
 * and the top bar shows the new scope.
 */
export function ScopeProposalCard({ id }: { id: string }) {
  const proposal = SCOPE_PROPOSALS[id]
  const confirmed = useActions().confirmed.includes(id)
  const { pick } = useWords()
  const toasts = Toast.useToastManager()
  if (!proposal) return <MissingCard kind="scope proposal" id={id} />

  const kinds = [...new Set(proposal.assets.map((asset) => asset.kind))]
  const waiting = proposal.assets.filter((asset) => !asset.proofOk)

  function confirm() {
    confirmScope(id)
    toasts.add({
      title: `Scope ${proposal.version} confirmed`,
      description: "The scope hash is fixed. No step is approved.",
    })
  }

  function change() {
    toasts.add({
      title: "Tell the agent what to change",
      description: "For example: drop acme.xyz. The agent posts a new proposal to confirm.",
    })
  }

  return (
    <CardFrame
      title={confirmed ? `Scope ${proposal.version} confirmed` : "Scope proposal"}
      tone={confirmed ? "success" : "warning"}
      meta={`Scope ${proposal.version} · ${proposal.assets.length} assets · ${proposal.neverTouch.length} never touch · ${
        confirmed ? "You typed the project name" : "Not confirmed. Nothing is tested."
      }`}
      actions={
        confirmed ? (
          <Muted className="type-xs">Confirmed. No step is approved. Each active step asks you when a run reaches it.</Muted>
        ) : (
          <>
            <ConfirmScope proposal={proposal} onConfirm={confirm} />
            <Button variant="secondary" onClick={change}>
              Change
            </Button>
            <Muted className="type-xs">Confirm accepts the scope. It approves no step.</Muted>
          </>
        )
      }
    >
      <ul className="flex flex-col">
        {proposal.assets.map((asset) => (
          <ProposedRow key={asset.name} asset={asset} />
        ))}
      </ul>

      <Part title="Proof">
        <KeyValues rows={kinds.map((kind) => [kind, PROOF_BY_KIND[kind]])} />
        <p className="type-xs">
          {waiting.length ? (
            <>
              <span className="weight-medium">{waiting.map((asset) => asset.name).join(", ")}</span> waits for proof.{" "}
            </>
          ) : null}
          <Muted>{pick(BEFORE_PROOF, BEFORE_PROOF_TECHNICAL)}</Muted>
        </p>
      </Part>

      <Part title="Never touch">
        <ul className="flex flex-col gap-(--space-xxs)">
          {proposal.neverTouch.map((rule) => (
            <li key={rule.item} className="flex items-baseline gap-(--space-xs)">
              <Dot tone="error" className="translate-y-[-1px]" />
              <span>
                <span className="weight-medium">{rule.item}.</span> <Muted>{rule.why}</Muted>
              </span>
            </li>
          ))}
        </ul>
      </Part>

      <Part title="What changed">
        {proposal.diff ? (
          <ScopeChanges changes={proposal.diff} />
        ) : (
          <Muted>First version. Nothing to compare.</Muted>
        )}
      </Part>

      <KeyValues
        rows={[
          [
            "Scope hash",
            <span key="hash">
              <span className="font-data">{proposal.scopeHash}</span>{" "}
              <Muted>{confirmed ? "Fixed." : "Preview. Fixed when you confirm."}</Muted>
            </span>,
          ],
        ]}
      />
    </CardFrame>
  )
}

/** One proposed asset: name, kind, access and why (C1), tier, proof. */
function ProposedRow({ asset }: { asset: ProposedAsset }) {
  return (
    <li className="flex flex-col gap-(--space-xxs) py-(--space-s) first:pt-0 not-last:divide-bottom">
      <div className="flex flex-wrap items-center gap-x-(--space-s) gap-y-(--space-xxs)">
        <span className="weight-medium">{asset.name}</span>
        <Muted className="type-xs">{asset.kind}</Muted>
        <span className="ml-auto flex items-center gap-(--space-xs)">
          <Tag>{asset.access} access</Tag>
          <Tag>{asset.tier}</Tag>
        </span>
      </div>
      <Muted className="type-xs">Access because: {asset.accessBecause}</Muted>
      <span className="flex items-center gap-(--space-xs) type-xs">
        <Dot tone={asset.proofOk ? "success" : "warning"} />
        Proof: {asset.proof}
      </span>
    </li>
  )
}

/** Confirm by typing the project name. No wallet. Nothing to approve here. */
function ConfirmScope({ proposal, onConfirm }: { proposal: ScopeProposal; onConfirm: () => void }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const inputId = useId()
  const matches = typed.trim() === proposal.confirmWord

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!matches) return
    setOpen(false)
    setTyped("")
    onConfirm()
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setTyped("")
      }}
    >
      <Button onClick={() => setOpen(true)}>Confirm</Button>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup>
          <form onSubmit={submit} className="flex flex-col gap-(--space-m)">
            <Dialog.Title>Confirm scope {proposal.version}</Dialog.Title>
            <Dialog.Description>
              This saves {proposal.version} and fixes its scope hash. It approves no step. Each active step asks you
              when a run reaches it.
            </Dialog.Description>
            <div className="flex flex-col gap-(--space-xs)">
              <InputLabel htmlFor={inputId}>Type “{proposal.confirmWord}” to confirm</InputLabel>
              <Input
                id={inputId}
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(event) => setTyped(event.currentTarget.value)}
              />
            </div>
            <div className="flex justify-end gap-(--space-s)">
              <Dialog.Close type="button">Cancel</Dialog.Close>
              <Dialog.Action type="submit" disabled={!matches}>
                Confirm {proposal.version}
              </Dialog.Action>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/* ---------- Blocked ---------- */

type BlockState = { label: string; tone: DotTone; whatLabel: string; link?: { to: string; text: string } }

const BLOCK_STATE: Record<string, BlockState> = {
  "outside-scope": {
    label: "Out of scope",
    tone: "orange",
    whatLabel: "Blocked",
    link: { to: "scope", text: "Open Found outside scope" },
  },
  "never-touch": {
    label: "Never touch",
    tone: "error",
    whatLabel: "Blocked",
    link: { to: "scope", text: "Open the Never touch list" },
  },
  "missing-setup": {
    label: "Missing setup",
    tone: "warning",
    whatLabel: "Blocked",
    link: { to: "settings", text: "Open Settings" },
  },
  "sandbox-down": {
    label: "Sandbox down",
    tone: "error",
    whatLabel: "What happened",
    link: { to: "settings", text: "Open Harness health" },
  },
  "target-429": { label: "Paused", tone: "warning", whatLabel: "What happened" },
  "rpc-limit": {
    label: "Stopped",
    tone: "error",
    whatLabel: "What happened",
    link: { to: "settings", text: "Open Settings" },
  },
  "pii-filter": {
    label: "Stopped",
    tone: "error",
    whatLabel: "What happened",
    link: { to: "settings", text: "Open Harness health" },
  },
}

const DEFAULT_BLOCK: BlockState = { label: "Blocked", tone: "warning", whatLabel: "Blocked" }

/**
 * Blocked by a rule or a missing input. id: BLOCKED key ("outside-scope",
 * "never-touch", "missing-setup", "sandbox-down", "target-429", "rpc-limit",
 * "pii-filter").
 */
export function BlockedCard({ id }: { id: string }) {
  const blocked = BLOCKED[id]
  if (!blocked) return <MissingCard kind="block" id={id} />
  const state = BLOCK_STATE[id] ?? DEFAULT_BLOCK
  const run = blocked.run !== null && RUNS[String(blocked.run)] ? blocked.run : null

  return (
    <CardFrame
      title={blocked.title}
      tone={state.tone}
      meta={`${state.label} · ${blocked.run !== null ? `Run #${blocked.run}` : "No run started"}`}
      actions={
        run !== null || state.link ? (
          <>
            {run !== null ? (
              <PanelLink view={`run/${run}`} className="type-s">
                Open run #{run}
              </PanelLink>
            ) : null}
            {state.link ? (
              <TextLink to={state.link.to} className="type-s">
                {state.link.text}
              </TextLink>
            ) : null}
          </>
        ) : undefined
      }
    >
      <KeyValues
        rows={[
          [state.whatLabel, blocked.what],
          [
            "Rule",
            <span key="rule">
              {blocked.rule} <Muted className="font-data">· {blocked.ruleId}</Muted>
            </span>,
          ],
          ["Next", blocked.next],
        ]}
      />
      <Muted className="type-xs">Code holds this rule, not a model. It is in the audit log.</Muted>
    </CardFrame>
  )
}

/* ---------- Stop ---------- */

/** A stop. id: STOPS key, "stop-all" or "provider-131". */
export function StopCard({ id }: { id: string }) {
  const stop = STOPS[id]
  if (!stop) return <MissingCard kind="stop" id={id} />
  const byProvider = stop.by === "Provider"
  const runs = stop.runs.map((run) => `#${run}`).join(", ")

  return (
    <CardFrame
      title={byProvider ? "Stopped by provider" : "Stopped by you"}
      tone={byProvider ? "error" : "warning"}
      meta={`${stop.at} · ${stop.runs.length === 1 ? "Run" : "Runs"} ${runs} stopped`}
      actions={stop.runs
        .filter((run) => RUNS[String(run)])
        .map((run) => (
          <PanelLink key={run} view={`run/${run}`} className="type-s">
            Open run #{run}
          </PanelLink>
        ))}
    >
      {byProvider ? <ProviderStop stop={stop} /> : null}

      <KeyValues
        rows={[
          ["Evidence kept", stop.evidenceKept],
          ["Steps not run", stop.notRun.join(". ")],
        ]}
      />

      <Part title="Cut, in order">
        <ol className="flex flex-col gap-(--space-xxs)">
          {stop.cut.map((cut, index) => (
            <li key={cut} className="flex gap-(--space-s)">
              <span className="w-(--space-m) shrink-0 font-data tabular-nums text-(--cte-text-muted)">{index + 1}</span>
              <span>{cut}</span>
            </li>
          ))}
        </ol>
      </Part>

      <Cleanup stop={stop} />
    </CardFrame>
  )
}

/** D8: the module that stopped. The run never moves to the host. */
function ProviderStop({ stop }: { stop: StopInfo }) {
  const { pick } = useWords()
  const step = RUNS[String(stop.runs[0])]?.steps.find((row) => row.n === stop.stepNumber)
  const module = stop.module ? moduleByKey(stop.module) : undefined
  return (
    <>
      <p>The sandbox provider ended the run sandbox. The run did not move to the host.</p>
      {step ? (
        <KeyValues
          rows={[
            [
              "Module that stopped",
              <span key="module">
                {module?.name ?? stop.module ?? step.module}. <Muted>Step {step.n}: {pick(step.plain, step.technical)}</Muted>
              </span>,
            ],
          ]}
        />
      ) : null}
    </>
  )
}

/** D4: "Cleanup you must do". An item stays until you mark it done. */
function Cleanup({ stop }: { stop: StopInfo }) {
  const yours = stop.cleanup.filter((item) => item.who === "you")
  const harness = stop.cleanup.filter((item) => item.who === "harness")
  const [done, setDone] = useState<string[]>(() => yours.filter((item) => item.done).map((item) => item.text))
  const open = yours.filter((item) => !done.includes(item.text)).length

  return (
    <>
      <Part title={open ? `Cleanup you must do · ${open} open` : "Cleanup you must do"}>
        {yours.length ? (
          <ul className="flex flex-col gap-(--space-xxs)">
            {yours.map((item) => (
              <li key={item.text}>
                <Checkbox.Row>
                  <Checkbox.Root
                    checked={done.includes(item.text)}
                    onCheckedChange={(checked) =>
                      setDone((list) =>
                        checked ? [...list, item.text] : list.filter((text) => text !== item.text),
                      )
                    }
                  />
                  <Checkbox.Label>{item.text}</Checkbox.Label>
                </Checkbox.Row>
              </li>
            ))}
          </ul>
        ) : (
          <Muted>Nothing for you to do.</Muted>
        )}
      </Part>
      {harness.length ? (
        <Part title="The harness cleans up">
          <ul className="flex flex-col gap-(--space-xxs)">
            {harness.map((item) => (
              <li key={item.text} className="flex items-center gap-(--space-xs)">
                <Dot tone={item.done ? "success" : "accent"} />
                <span>{item.text}</span>
                <Muted className="ml-auto type-xs">{item.done ? "Done" : "In progress"}</Muted>
              </li>
            ))}
          </ul>
        </Part>
      ) : null}
    </>
  )
}

/* ---------- Setup needed ---------- */

const SETUP_STATE: Record<SetupRow["state"], { word: string; tone: DotTone }> = {
  ok: { word: "OK", tone: "success" },
  running: { word: "Running", tone: "accent" },
  missing: { word: "Missing", tone: "warning" },
}

/** Setup needed before a run. id: SETUP_NEEDED key, "first-run". */
export function SetupNeededCard({ id }: { id: string }) {
  const setup = SETUP_NEEDED[id]
  if (!setup) return <MissingCard kind="setup" id={id} />
  const ready = setup.rows.filter((row) => row.state === "ok").length
  const done = ready === setup.rows.length

  return (
    <CardFrame
      title={done ? "Setup done" : "Setup needed"}
      tone={done ? "success" : "warning"}
      meta={`${ready} of ${setup.rows.length} ready`}
    >
      <ul className="flex flex-col">
        {setup.rows.map((row) => {
          const state = SETUP_STATE[row.state]
          const how = row.state === "ok" ? undefined : row.how
          return (
            <li key={row.label} className="flex flex-col gap-(--space-xxs) py-(--space-xs) first:pt-0 not-last:divide-bottom">
              <div className="flex items-center gap-(--space-xs)">
                <Dot tone={state.tone} />
                <span>{row.label}</span>
                <Muted className="ml-auto type-xs">{state.word}</Muted>
              </div>
              <Muted className="type-xs">{row.detail}</Muted>
              {how ? (
                <span className="type-xs">
                  <span className="weight-medium">{row.state === "missing" ? "How to add it:" : "Next:"}</span> {how}
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
      <p className="type-xs weight-medium">{setup.note}</p>
    </CardFrame>
  )
}
