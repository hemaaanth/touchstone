// Where the run panel's layer sits (run-chat.tsx). Desktop: inside the chat
// area, below the top bar (which keeps no room for it), 12 px from the chat's
// top and right edges, and 12 px above the composer's top, also when the
// composer grows. Phone: below the bar, across the width, its bottom as before.
export function panelLayerClass(narrow: boolean): string {
  return narrow ? "top-[54px] right-3 left-3 bottom-28" : "top-3 right-3 bottom-[calc(var(--composer-room,100px)+12px)]"
}

// The ref for the composer's wrapper (run-thread.tsx). It keeps
// --composer-room on the run's chat area ([data-run-chat-area]) at the
// distance from the area's bottom up to the composer box's top. A
// ResizeObserver runs after layout and before paint, so the panel moves in the
// same frame as the composer grows: no jump while typing. With no composer
// (a peek), the variable is gone and the layer keeps its old 112 px.
export function composerRoomRef(el: HTMLElement | null): (() => void) | undefined {
  const area = el?.closest<HTMLElement>("[data-run-chat-area]")
  if (!el || !area) return
  const measure = () => {
    const box = el.querySelector("form") ?? el
    const room = area.getBoundingClientRect().bottom - box.getBoundingClientRect().top
    area.style.setProperty("--composer-room", `${Math.max(0, Math.round(room))}px`)
  }
  measure()
  const ro = new ResizeObserver(measure)
  ro.observe(el)
  return () => {
    ro.disconnect()
    area.style.removeProperty("--composer-room")
  }
}
