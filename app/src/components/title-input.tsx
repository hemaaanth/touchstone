import { useEffect, useRef, useState } from "react"
import { cn } from "cn"

// An inline input that renames a run in place. It opens with the current title
// selected. Enter or leaving the field saves; Escape cancels. Saving an empty
// field clears the name, so the run shows its default title again. Saving the
// same text changes nothing.
//
// The input takes the place of the title text without moving anything: a
// hidden copy of the text sizes the box, so it is as wide as the title it
// replaces and grows as the operator types. The ring is an outline, so it
// takes no space either. The caret starts at the front, so the start of a long
// title stays in view.
export function TitleInput({
  value,
  onSave,
  onCancel,
  className,
}: {
  value: string
  onSave: (name: string) => void
  onCancel: () => void
  className?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(value)
  // Enter and blur both fire for one edit; only the first one counts.
  const done = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(0, el.value.length, "backward")
    el.scrollLeft = 0
  }, [])
  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    const next = text.trim()
    if (save && next !== value) onSave(next)
    else onCancel()
  }
  return (
    <span className={cn("inline-grid min-w-0 max-w-full", className)}>
      <span aria-hidden className="invisible col-start-1 row-start-1 overflow-hidden whitespace-pre">
        {text || " "}
      </span>
      <input
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Run name"
        maxLength={120}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === "Enter") finish(true)
          if (e.key === "Escape") finish(false)
        }}
        onClick={(e) => e.stopPropagation()}
        className="col-start-1 row-start-1 w-full min-w-0 rounded-[3px] bg-transparent p-0 font-[inherit] outline-1 outline-offset-2 outline-ring/70 [font-size:inherit] [line-height:inherit]"
      />
    </span>
  )
}
