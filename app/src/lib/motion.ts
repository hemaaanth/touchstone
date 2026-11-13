import { useEffect, type RefObject } from "react"

// Small, fast motion for the run panel. useAppear and Bump use the Web Animations
// API, so no class toggles and no extra re-renders. Both do nothing when the
// operator asks for reduced motion.

export const reduced = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

// A new row eases in: a short fade and a 4px drop. Rows that were there when
// the list mounted never animate, and a row animates only once, when React
// inserts its node. Inline spans inside a row (a status word, a tag) are not
// rows, so they do not animate.
export function useAppear(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current
    if (!root || typeof MutationObserver === "undefined") return
    const observer = new MutationObserver((records) => {
      if (reduced()) return
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (!(node instanceof HTMLElement) || node.tagName === "SPAN") continue
          node.animate(
            [
              { opacity: 0, transform: "translateY(-4px)" },
              { opacity: 1, transform: "none" },
            ],
            { duration: 140, easing: "cubic-bezier(0.2, 0, 0, 1)" },
          )
        }
      }
    })
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [ref])
}
