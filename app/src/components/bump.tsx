import { useLayoutEffect, useRef } from "react"
import { cn } from "cn"
import { reduced } from "@/lib/motion"

// A number that bumps when it goes up: a quick scale pulse, so a new agent,
// note, finding or file is noticed without pulling the eye for long. The first
// render and a drop do not bump.
export function Bump({ n, className }: { n: number; className?: string }) {
  const el = useRef<HTMLSpanElement>(null)
  const last = useRef(n)
  useLayoutEffect(() => {
    const prev = last.current
    last.current = n
    if (n <= prev || !el.current || reduced()) return
    el.current.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(1.25)", color: "var(--color-foreground)" },
        { transform: "scale(1)" },
      ],
      { duration: 140, easing: "ease-out" },
    )
  }, [n])
  return (
    <span ref={el} className={cn("inline-block tabular-nums", className)}>
      {n}
    </span>
  )
}
