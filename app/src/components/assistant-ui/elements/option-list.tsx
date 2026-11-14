"use client"

/*
Adapted from assistant-ui/assistant-ui at 7d7427653f6ba47b0b954510eed9c594d64e74d5:
packages/ui/src/components/react/assistant-ui/elements/option-list.tsx
Changes: base-nova Button/theme, rounded surface with custom-reply footer, external busy state, synchronous
submission lock, and local bounds in place of registry helpers. No runtime completion API.

MIT License

Copyright (c) 2026 AgentbaseAI Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import { useId, useRef, useState, type ComponentProps, type ReactNode } from "react"
import { CheckIcon, Loader2Icon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

export interface OptionListOption {
  id: string
  label: string
  description?: string
  disabled?: boolean
}

export interface OptionListProps extends Omit<ComponentProps<"div">, "children" | "defaultValue" | "onChange"> {
  options: readonly OptionListOption[]
  selectionMode?: "single" | "multiple"
  defaultValue?: readonly string[]
  minSelections?: number
  maxSelections?: number
  onConfirm?: (ids: string[]) => void | Promise<void>
  confirmLabel?: string
  choice?: readonly string[]
  disabled?: boolean
  children?: ReactNode
}

const row = "focus-ring flex h-auto w-full min-w-0 items-start justify-start gap-3 rounded-lg px-3 py-3 text-left !whitespace-normal"

function OptionText({ option, descriptionId }: { option: OptionListOption; descriptionId: string }) {
  return <span className="flex min-w-0 flex-1 flex-col gap-0.5 [overflow-wrap:anywhere]">
    <span className="text-sm leading-5">{option.label}</span>
    {option.description ? <span id={descriptionId} className="text-xs leading-4 text-muted-foreground">{option.description}</span> : null}
  </span>
}

export function OptionList({
  options, selectionMode = "single", defaultValue, minSelections = 1, maxSelections,
  onConfirm, confirmLabel = "Confirm choices", choice, disabled = false, children, className, ...props
}: OptionListProps) {
  const multiple = selectionMode === "multiple"
  const [selected, setSelected] = useState<readonly string[]>(() => (defaultValue ?? []).filter((id) => options.some((o) => o.id === id)))
  const [pending, setPending] = useState<readonly string[] | null>(null)
  const [confirmed, setConfirmed] = useState<readonly string[] | undefined>()
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)
  const descriptionPrefix = useId()
  const root = cn("flex w-full min-w-0 max-w-xl flex-col gap-0.5 overflow-hidden rounded-2xl border border-border/60 bg-muted/20 p-1", className)
  const confirmedChoice = choice ?? confirmed

  if (confirmedChoice !== undefined) {
    const chosen = options.filter((option) => confirmedChoice.includes(option.id))
    return <div data-slot="option-list" data-state="receipt" className={root} {...props}>
      {chosen.length ? chosen.map((option) => <div key={option.id} className={row}>
        <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="sr-only">Selected:</span>
        <OptionText option={option} descriptionId={`${descriptionPrefix}-${option.id}`} />
      </div>) : <span className="px-2 py-2 text-xs text-muted-foreground">Nothing selected</span>}
    </div>
  }

  if (!onConfirm) return <div data-slot="option-list" className={root} {...props}>
    {options.map((option) => <div key={option.id} className={row}><OptionText option={option} descriptionId={`${descriptionPrefix}-${option.id}`} /></div>)}
    {children ? <div className="mt-1 border-t border-border/60 p-2">{children}</div> : null}
  </div>

  const locked = disabled || pending !== null
  const max = Math.floor(Math.max(0, Math.min(maxSelections ?? options.length, options.length)))
  const min = Math.floor(Math.max(0, Math.min(minSelections, max)))
  const selectedIds = selected.filter((id) => options.some((option) => option.id === id))
  const count = selectedIds.length
  const canConfirm = !locked && count >= min && count <= max
  const commit = (ids: string[]) => {
    if (locked || submitting.current) return
    submitting.current = true
    setPending(ids)
    setError(null)
    void (async () => {
      try {
        await onConfirm(ids)
        setConfirmed(ids)
      } catch (cause) {
        submitting.current = false
        setPending(null)
        setError(cause instanceof Error ? cause.message : "The choice was not accepted.")
      }
    })()
  }

  return <div role="group" data-slot="option-list" data-state={pending !== null ? "pending" : "open"} aria-busy={pending !== null || undefined} className={root} {...props}>
    {options.map((option) => {
      const isSelected = multiple ? selectedIds.includes(option.id) : (pending ?? selected).includes(option.id)
      const unavailable = option.disabled === true || (multiple && !isSelected && count >= max)
      return <Button
        key={option.id} type="button" variant="ghost"
        {...(multiple ? { role: "checkbox", "aria-checked": isSelected } : {})}
        aria-label={option.label} aria-describedby={option.description ? `${descriptionPrefix}-${option.id}` : undefined}
        disabled={unavailable || locked}
        onClick={() => {
          if (unavailable || locked || submitting.current) return
          if (multiple) setSelected((current) => {
            const available = current.filter((id) => options.some((o) => o.id === id))
            return available.includes(option.id) ? available.filter((id) => id !== option.id) : available.length < max ? [...available, option.id] : available
          })
          else commit([option.id])
        }}
        className={cn(row, isSelected && "bg-foreground/[0.06]", unavailable && "text-muted-foreground")}
      >
        {multiple ? <span aria-hidden className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-sm bg-foreground/10">
          {isSelected ? <CheckIcon className="size-3" /> : null}
        </span> : pending?.includes(option.id) ? <Loader2Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 animate-spin motion-reduce:animate-none" /> : null}
        <OptionText option={option} descriptionId={`${descriptionPrefix}-${option.id}`} />
      </Button>
    })}
    {error ? <p role="alert" className="px-2 py-1 text-xs break-words">{error}</p> : null}
    {multiple ? <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1">
      <span aria-live="polite" className="text-xs text-muted-foreground">{count} selected · choose {min === max ? min : `${min}–${max}`}</span>
      <Button type="button" size="sm" variant="outline" disabled={!canConfirm} onClick={() => {
        if (canConfirm) commit(options.filter((option) => selectedIds.includes(option.id)).map((option) => option.id))
      }}>{pending !== null ? <Loader2Icon aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" /> : null}{confirmLabel}</Button>
    </div> : null}
    {children ? <div className="mt-1 border-t border-border/60 p-2">{children}</div> : null}
  </div>
}
