import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { answerRunAsk, AskAnswerError } from "@/lib/api"
import { reloadRun, type RunState } from "@/lib/runModel"
import { COORDINATOR, formatAskChoiceReply, type AskAnswer, type AskReceipt, type HumanAsk } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { OptionList } from "@/components/assistant-ui/elements/option-list"

type Draft = { reply?: string; choices?: string[]; pending?: boolean; uncertain?: boolean; error?: string; accepted?: AskReceipt; candidate?: AskAnswer }
type AskContextValue = {
  state: RunState | null
  live: boolean
  drafts: Record<string, Draft>
  patch: (id: string, value: Partial<Draft>) => void
  submit: (ask: HumanAsk, body: AskAnswer, choices?: string[]) => Promise<void>
  refresh: () => void
}
const AskContext = createContext<AskContextValue | null>(null)

// One action path for choices, Reply, Done and Cancel, including child peeks.
// This is an ephemeral HTTP/SSE overlay, never an event or an answer cache.
export function AskHumanProvider({ runId, state, live, children }: { runId: string; state: RunState | null; live: boolean; children: ReactNode }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const current = useRef({ state, live, drafts })
  current.current = { state, live, drafts }
  const sending = useRef(new Set<string>())
  const patch = (id: string, value: Partial<Draft>) => {
    const next = { ...current.current.drafts, [id]: { ...current.current.drafts[id], ...value } }
    current.current.drafts = next
    setDrafts(next)
  }
  useEffect(() => {
    for (const ask of state?.humanAsks ?? []) {
      const draft = current.current.drafts[ask.id]
      if (draft?.accepted && ask.receipt) patch(ask.id, { accepted: undefined, candidate: undefined })
    }
  }, [state])
  const submit = async (original: HumanAsk, body: AskAnswer, choices?: string[]) => {
    const ask = current.current.state?.humanAsks.find((a) => a.id === original.id && a.agent === original.agent)
    const draft = current.current.drafts[original.id] ?? {}
    if (!current.current.live || !ask || ask.answer || draft.accepted || sending.current.has(ask.id)) throw new Error("This request is not available for another answer.")
    if ("reply" in body && (!body.reply.trim() || body.reply.length > 4000)) throw new Error("Enter a reply of 1 to 4,000 characters.")
    if (draft.uncertain && JSON.stringify(draft.candidate) !== JSON.stringify(body)) throw new Error("Delivery is uncertain. Retry the original answer or refresh its status.")
    sending.current.add(ask.id)
    patch(ask.id, { pending: true, error: undefined, candidate: body, ...(choices ? { choices } : {}) })
    try {
      const result = await answerRunAsk(runId, body)
      const expected = "reply" in body ? "reply" : body.done ? "done" : "cancel"
      if (result.ok !== true || result.receipt.id !== ask.id || result.receipt.agent !== ask.agent || result.receipt.answer !== expected) throw new Error("The accepted answer did not match this question. Refresh its status.")
      patch(ask.id, { pending: false, uncertain: false, accepted: result.receipt, error: undefined })
    } catch (cause) {
      const uncertain = draft.uncertain === true || !(cause instanceof AskAnswerError) || cause.uncertain
      patch(ask.id, { pending: false, uncertain, candidate: uncertain ? body : undefined, error: cause instanceof Error ? cause.message : "The answer was not accepted." })
      throw cause
    } finally { sending.current.delete(ask.id) }
  }
  return <AskContext.Provider value={{ state, live, drafts, patch, submit, refresh: () => reloadRun(runId) }}>{children}</AskContext.Provider>
}

export function PendingAskLinks({ onOpen }: { onOpen: (agent: string, key: string) => void }) {
  const context = useContext(AskContext)
  const pending = context?.live ? context.state?.humanAsks.filter((a) => !a.answer && a.agent !== COORDINATOR && !context.drafts[a.id]?.accepted) ?? [] : []
  if (!pending.length) return null
  return <nav aria-label="Pending questions" className="flex min-w-0 flex-wrap items-center gap-2 px-4 py-1 text-xs">
    <span className="text-muted-foreground">Waiting for you · {pending.length}</span>
    {pending.map((ask) => <Button key={ask.id} size="sm" variant="ghost" onClick={() => onOpen(ask.agent, `ask:${ask.id}`)}>{context?.state?.agents.find((a) => a.id === ask.agent)?.name ?? ask.agent} · question</Button>)}
  </nav>
}

export function AskHuman({ ask }: { ask: HumanAsk }) {
  const context = useContext(AskContext)
  const draft = context?.drafts[ask.id] ?? {}
  const questionId = useId()
  const name = context?.state?.agents.find((a) => a.id === ask.agent)?.name ?? (ask.agent === COORDINATOR ? "Coordinator" : ask.agent)
  const receipt = ask.receipt ?? draft.accepted
  const answer = ask.answer ?? receipt?.answer
  const live = !!context?.live && !answer
  const presentation = ask.presentation
  const failed = (cause: unknown) => context?.patch(ask.id, { error: cause instanceof Error ? cause.message : "The answer was not accepted." })
  const submit = (body: AskAnswer, choices?: string[]) => context ? context.submit(ask, body, choices) : Promise.reject(new Error("This request is read-only."))
  return <section data-slot="ask-human" data-ask-id={ask.id} aria-labelledby={questionId} aria-busy={draft.pending || undefined} className="flex min-w-0 flex-col gap-2 bg-muted/20 px-3 py-3 text-sm">
    <p className="text-xs text-muted-foreground">{name} · {ask.kind}</p>
    <p id={questionId} className="whitespace-pre-wrap break-words">{ask.question}</p>
    {ask.detail ? <Collapsible><CollapsibleTrigger className="focus-ring w-fit text-xs text-muted-foreground">Request details</CollapsibleTrigger><CollapsibleContent><pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all">{ask.detail}</pre></CollapsibleContent></Collapsible> : null}
    {answer ? <div data-slot="ask-receipt" className="flex min-w-0 flex-col gap-2 text-muted-foreground">
      {ask.interrupted ? <p>Request interrupted. No approval was restored.</p> : <>
        <p>{answer === "reply" ? "Answered" : answer === "done" ? "Done for this request" : "Cancelled"}</p>
        {answer === "reply" && receipt?.text !== undefined ? <p className="whitespace-pre-wrap break-words">{receipt.text}</p> : answer === "reply" ? <p>The answer text was not saved.</p> : null}
        {answer === "reply" && presentation && draft.choices ? <OptionList options={presentation.options} choice={draft.choices} /> : null}
      </>}
    </div> : draft.pending ? <p role="status">Waiting for the agent to accept this answer…</p> : draft.uncertain ? <>
      <p role="status">Delivery is uncertain. Only the original answer can be retried until its status is known.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!live || !draft.candidate} onClick={() => draft.candidate && void submit(draft.candidate).catch(failed)}>Retry original answer</Button>
        <Button size="sm" variant="ghost" onClick={() => context?.refresh()}>Refresh answer status</Button>
      </div>
    </> : <>
      <p className="text-xs text-muted-foreground">Replies are visible to the agent. Keep passwords and codes in the browser, never in Reply. Do not include secrets. Done approves only this request. Reply and Cancel do not approve it.</p>
      {presentation ? <OptionList aria-labelledby={questionId} options={presentation.options} selectionMode={presentation.select} minSelections={presentation.select === "multiple" ? presentation.min : undefined} maxSelections={presentation.select === "multiple" ? presentation.max : undefined} defaultValue={draft.choices} disabled={!live} onConfirm={live ? (ids) => submit({ ask: ask.id, reply: formatAskChoiceReply(presentation, ids) }, ids) : undefined} /> : null}
      <form className="flex min-w-0 flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void submit({ ask: ask.id, reply: draft.reply ?? "" }).catch(failed) }}>
        <Input aria-label={`Reply to ${name}`} value={draft.reply ?? ""} onChange={(e) => context?.patch(ask.id, { reply: e.target.value })} disabled={!live} className="min-w-32 flex-1" />
        <Button type="submit" size="sm" variant="outline" disabled={!live || !draft.reply?.trim()}>Reply</Button>
        {!presentation ? <Button type="button" size="sm" disabled={!live} onClick={() => void submit({ ask: ask.id, done: true }).catch(failed)}>Done</Button> : null}
        <Button type="button" size="sm" variant="ghost" disabled={!live} onClick={() => void submit({ ask: ask.id, done: false }).catch(failed)}>Cancel</Button>
      </form>
    </>}
    {draft.error && !answer ? <p role="alert" className="whitespace-pre-wrap break-words">{draft.error}</p> : null}
  </section>
}
