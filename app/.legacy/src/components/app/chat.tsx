import { useState, type FormEvent, type ReactNode } from "react"
import { Button, Input, Toast } from "@graphical"
import { Muted, Scroll } from "@/components/app/blocks"
import { ChatCard, PanelLink } from "@/components/app/cards"
import type { ChatMessage } from "@/data/fixtures"

/*
 * The agent chat. One chat replaces the 13 module screens.
 *   ChatColumn  the scrolling turns, an optional block above them, the composer
 *   AgentTurn   the agent's words, then its card, then a panel link
 *   YouTurn     your words, on the right
 *   Composer    one line and Send. The mockup does not call a model.
 * A turn names a card as { kind, id } and an optional panel view to open.
 */

export function ChatColumn({
  messages,
  top,
  composer = <Composer />,
}: {
  messages: ChatMessage[]
  /** Shown above the turns and scrolls with them. Home puts the Answer here. */
  top?: ReactNode
  /** Pass null to hide the composer. */
  composer?: ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Scroll>
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-(--space-l) px-(--space-xl) py-(--space-xl)">
          {top}
          {messages.map((message, index) =>
            message.role === "you" ? (
              <YouTurn key={index} message={message} />
            ) : (
              <AgentTurn key={index} message={message} />
            ),
          )}
        </div>
      </Scroll>
      {composer ? (
        <div className="shrink-0 bg-(--cte-surface) divide-top">
          <div className="mx-auto w-full max-w-[720px] px-(--space-xl) py-(--space-s)">{composer}</div>
        </div>
      ) : null}
    </div>
  )
}

export function AgentTurn({ message }: { message: ChatMessage }) {
  return (
    <article className="flex flex-col gap-(--space-s)">
      <Muted className="type-xs">
        Agent · <span className="font-data">{message.time}</span>
      </Muted>
      <p className="type-s">{message.text}</p>
      {message.card ? <ChatCard kind={message.card.kind} id={message.card.id} /> : null}
      {message.panel ? (
        <PanelLink view={message.panel} className="self-start type-s">
          Open {message.panel}
        </PanelLink>
      ) : null}
    </article>
  )
}

export function YouTurn({ message }: { message: ChatMessage }) {
  return (
    <article className="flex flex-col items-end gap-(--space-xxs)">
      <Muted className="type-xs">
        You · <span className="font-data">{message.time}</span>
      </Muted>
      <p className="max-w-[80%] rounded-(--radius-m) bg-(--cte-surface-muted) px-(--space-m) py-(--space-s) type-s">
        {message.text}
      </p>
    </article>
  )
}

export function Composer({
  placeholder = "Ask the agent. For example: check the Vault again",
  onSend,
}: {
  placeholder?: string
  /** Called with the text. Without it, the mockup says the agent is not wired. */
  onSend?: (text: string) => void
}) {
  const [text, setText] = useState("")
  const toasts = Toast.useToastManager()

  function submit(event: FormEvent) {
    event.preventDefault()
    const value = text.trim()
    if (!value) return
    if (onSend) onSend(value)
    else toasts.add({ title: "Not sent", description: "This mockup reads fixtures. The agent does not answer yet." })
    setText("")
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-(--space-s)">
      <Input
        aria-label="Message the agent"
        className="min-w-0 flex-1"
        placeholder={placeholder}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <Button type="submit" disabled={!text.trim()}>
        Send
      </Button>
    </form>
  )
}
