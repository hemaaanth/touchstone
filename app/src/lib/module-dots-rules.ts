// When the ModuleDots pill (src/components/module-dots.tsx) may open and what
// closes it. Plain functions over EventTargets, so a test can drive them
// without a browser.

// A hover that comes this soon after the mark's own list scrolled opens
// nothing: a scroll drops the pill, and the browser then sends a fresh
// pointer-enter to whatever mark is under the resting pointer.
export const SCROLL_QUIET = 300

// When each scroll container last scrolled, by container.
const lastScroll = new WeakMap<EventTarget, number>()
export function noteScroll(target: EventTarget, now: number) {
  lastScroll.set(target, now)
}

// Whether a hover may open the pill now: the pointer is still on the mark, the
// user has not just closed it by hand, and none of the mark's own scroll
// containers moved in the last SCROLL_QUIET ms. Scrolling elsewhere (a live
// chat that follows its stream) does not count.
export function mayHoverOpen(state: { over: boolean; shut: boolean; containers: readonly EventTarget[]; now: number }) {
  if (!state.over || state.shut) return false
  return !state.containers.some((c) => {
    const t = lastScroll.get(c)
    return t !== undefined && state.now - t < SCROLL_QUIET
  })
}

// Call `drop` when one of the mark's own scroll containers scrolls, and only
// then. Returns the function that stops listening.
export function dropOnOwnScroll(containers: readonly EventTarget[], drop: () => void): () => void {
  for (const c of containers) c.addEventListener("scroll", drop, { passive: true })
  return () => {
    for (const c of containers) c.removeEventListener("scroll", drop)
  }
}

// The pill is display-only, so a wheel over its portion outside the list
// would normally scroll the chat underneath. Route only that portion back to
// the list; its own scroll listener then closes the pill. Inside the list,
// leave the browser's native wheel handling alone.
export function routePillWheel(e: WheelEvent, pill: DOMRect, list: HTMLElement): boolean {
  if (e.defaultPrevented || e.ctrlKey || list.contains(e.target as Node) ||
      e.clientX < pill.left || e.clientX >= pill.right || e.clientY < pill.top || e.clientY >= pill.bottom) return false
  const line = e.deltaMode === 1 ? parseFloat(getComputedStyle(list).lineHeight) || 16 : 1
  const x = e.deltaMode === 2 ? list.clientWidth : line
  const y = e.deltaMode === 2 ? list.clientHeight : line
  e.preventDefault()
  list.scrollBy({ left: e.deltaX * x, top: e.deltaY * y })
  return true
}

// A tap outside that closed the pill does nothing else: the click that ends
// that tap is stopped before it reaches what lies under the finger. Call it on
// the pointerdown; it stops one click, until that pointer goes up (or is
// cancelled by a scroll gesture).
export function swallowTapClick(target: EventTarget) {
  const stop = (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
    end()
  }
  const later = () => setTimeout(end, 0)
  const end = () => {
    target.removeEventListener("click", stop, true)
    target.removeEventListener("pointerup", later, true)
    target.removeEventListener("pointercancel", end, true)
  }
  target.addEventListener("click", stop, true)
  target.addEventListener("pointerup", later, true)
  target.addEventListener("pointercancel", end, true)
}
