import { useEffect, useRef } from "react"
import { cn } from "cn"

// An inline input that renames a run in place. It opens with the current title
// selected. Enter or leaving the field saves; Escape cancels. Saving an empty
// field clears the name, so the run shows its default title again. Saving the
// same text changes nothing.
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
  // Enter and blur both fire for one edit; only the first one counts.
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    const next = ref.current?.value.trim() ?? ""
    if (save && next !== value) onSave(next)
    else onCancel()
  }
  return (
    <input
      ref={ref}
      defaultValue={value}
      aria-label="Run name"
      maxLength={120}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Enter") finish(true)
        if (e.key === "Escape") finish(false)
      }}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "min-w-0 rounded-sm bg-transparent px-1 -mx-1 outline-none ring-1 ring-ring/60 focus-visible:ring-ring",
        className,
      )}
    />
  )
}
