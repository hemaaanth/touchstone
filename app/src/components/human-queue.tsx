import { useState } from "react"
import type { HumanAsk } from "@/lib/types"
import type { RunState } from "@/lib/runModel"
import { answerRunAsk } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

export function HumanQueue({ runId, state, live }: { runId: string; state: RunState; live: boolean }) {
  const asks = state.humanAsks.filter((a) => !a.answer)
  if (!asks.length) return null
  return (
    <section aria-label="Human queue" className="max-h-[45vh] shrink-0 overflow-auto bg-muted/20 px-4 py-2 text-xs">
      {asks.length ? <h2 className="py-1 font-medium">Waiting for you · {asks.length}</h2> : null}
      {asks.map((ask) => <AskRow key={ask.id} runId={runId} ask={ask} live={live} name={state.agents.find((a) => a.id === ask.agent)?.name ?? ask.agent} />)}
      <p className="py-1 text-muted-foreground">Built-in browser streaming and takeover are not enabled in this release.</p>
    </section>
  )
}

function AskRow({ runId, ask, live, name }: { runId: string; ask: HumanAsk; live: boolean; name: string }) {
  const [reply, setReply] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const answer = async (action: "done" | "reply" | "cancel") => {
    setBusy(true)
    setError(null)
    try {
      await answerRunAsk(runId, action === "reply" ? { ask: ask.id, reply } : { ask: ask.id, done: action === "done" })
      setReply("")
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The answer was not accepted.") }
    finally { setBusy(false) }
  }
  return <div className="flex flex-col gap-2 py-2">
    <p className="text-muted-foreground">{name} · {ask.kind}</p>
    <p className="whitespace-pre-wrap break-words">{ask.question}</p>
    {ask.detail ? <Collapsible><CollapsibleTrigger className="focus-ring w-fit text-muted-foreground">Request details</CollapsibleTrigger><CollapsibleContent><pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all">{ask.detail}</pre></CollapsibleContent></Collapsible> : null}
    <p className="text-muted-foreground">Keep passwords and codes in the browser. Done approves only this request. Reply and Cancel do not approve it.</p>
    <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void answer("reply") }}>
      <Input aria-label={`Reply to ${name}`} value={reply} maxLength={4000} onChange={(e) => setReply(e.target.value)} disabled={!live || busy} className="min-w-32 flex-1" />
      <Button type="submit" size="sm" variant="outline" disabled={!live || busy || !reply.trim()}>Reply</Button>
      <Button size="sm" disabled={!live || busy} onClick={() => void answer("done")}>Done</Button>
      <Button size="sm" variant="ghost" disabled={!live || busy} onClick={() => void answer("cancel")}>Cancel</Button>
    </form>
    {busy ? <p role="status">Waiting for the agent to accept this answer…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>
}
