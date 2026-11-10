import { useRef, useState } from "react"
import { Button, ThemedIcon } from "@graphical"
import { steerRun } from "@/lib/api"

// The steering composer. While the agent is working, the operator can inject a
// message into the current turn — native pi-durable steering. The message rides
// into the agent's in-flight run and is echoed back into the transcript as an
// operator step, so sending reads as joining the conversation, not queuing a
// new request.
//
// It is only mounted live; when the run is not steerable the pane shows a quiet
// line instead of a disabled box, so a dead control never sits under the cursor.
export function Composer({ runId }: { runId: string }) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)

  const trimmed = text.trim()
  const canSend = trimmed.length > 0 && !busy

  const send = () => {
    if (!canSend) return
    setBusy(true)
    setError(null)
    steerRun(runId, trimmed)
      .then(() => {
        // The message echoes back through the event stream as an operator step,
        // so we just clear the box — no optimistic insert to reconcile.
        setText("")
        ref.current?.focus()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not send"))
      .finally(() => setBusy(false))
  }

  return (
    <div className="shrink-0 divide-top p-(--space-m)">
      <div
        className="flex items-end gap-(--space-s) rounded-(--radius-m) p-(--space-s)"
        style={{ background: "var(--cte-surface)", boxShadow: "inset 0 0 0 1px var(--cte-border)" }}
      >
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline — the usual chat affordance.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          rows={1}
          placeholder="Steer the agent — redirect it, add a constraint, point at a function…"
          className="max-h-[120px] min-h-(--line-m) flex-1 resize-none bg-transparent type-s text-(--cte-text) outline-none placeholder:text-(--cte-text-muted)"
          aria-label="Steer the agent"
        />
        <Button variant="primary" onClick={send} disabled={!canSend} aria-label="Send steer">
          <ThemedIcon name={busy ? "loader" : "arrowUp"} />
        </Button>
      </div>
      {error ? (
        <p className="mt-(--space-xs) type-xxs text-(--cte-text-muted)">{error}</p>
      ) : (
        <p className="mt-(--space-xs) type-xxs text-(--cte-text-muted)">
          Your message joins the agent's current turn. Enter to send, Shift+Enter for a new line.
        </p>
      )}
    </div>
  )
}
