// The geometry of ModuleDots (src/components/module-dots.tsx): the small mark
// at rest, and where the open pill may go. Pure numbers, so the row that holds
// the mark can leave room for it, and a test can check them.

// A dot, and the step from one dot to the next in the stack (they overlap).
export const DOT = 8
export const STEP = 5
// The mark's inner space on each side, at rest. The open pill's left edge is
// the mark's left edge, so this space is where the pill's padding starts.
export const PAD = 4
// The mark's height at rest, and one line of the open pill.
export const REST_H = 16
export const LINE_H = 20

// Open: the pill's padding, the space between a dot and its name, and between
// two modules (across a line and from one line to the next).
export const OPEN_PAD_X = 8
export const OPEN_PAD_Y = 2
export const NAME_GAP = 5
export const ITEM_GAP_X = 12
export const ITEM_GAP_Y = 2

// The open pill keeps this far from the screen's right edge.
export const EDGE = 8
// The widest the open pill gets. Four modules fit on one line; more wrap
// onto balanced lines instead of one long strip across the page.
export const MAX_OPEN_W = 560
// The narrowest the open pill may be before it moves left to fit the screen.
export const MIN_OPEN_W = 200

// The mark's width at rest for n modules: every module has a dot. No modules
// keep the place of one dot, so a column stays in line.
export function restWidth(n: number): number {
  return 2 * PAD + DOT + STEP * Math.max(0, n - 1)
}

// Dot i's left edge inside the mark, at rest.
export function restDotLeft(i: number): number {
  return PAD + STEP * i
}

// How wide the open pill may grow. It keeps the mark's left edge and grows
// right, wrapping onto more lines when the screen is not wide enough. When not
// even MIN_OPEN_W fits to the right (a phone, a mark near the right edge), it
// may be MIN_OPEN_W wide and pillLeft moves it left to stay on the screen.
export function pillMaxWidth(markLeft: number, viewportWidth: number): number {
  const room = viewportWidth - EDGE - markLeft
  return Math.min(MAX_OPEN_W, room >= MIN_OPEN_W ? room : Math.min(MIN_OPEN_W, viewportWidth - 2 * EDGE))
}

// The open pill's left edge: the mark's own, unless the pill would cross the
// screen's right edge; then just far enough left to fit.
export function pillLeft(markLeft: number, openWidth: number, viewportWidth: number): number {
  return Math.max(EDGE, Math.min(markLeft, viewportWidth - EDGE - openWidth))
}

// The open pill: its size, and each module's dot (top-left) and name width.
export type OpenLayout = { w: number; h: number; dots: { x: number; y: number; nameW: number; cut: boolean }[] }

// Lay the open pill out from each name's natural width (px, one line). One
// line when it fits in maxWidth; otherwise the fewest lines that fit, at the
// narrowest width that keeps that count, so the lines come out balanced (no
// name alone on a last line). A name that cannot fit even alone is cut.
export function openLayout(nameWidths: readonly number[], maxWidth: number): OpenLayout {
  const inner = maxWidth - 2 * OPEN_PAD_X
  const items = nameWidths.map((n) => {
    const full = DOT + NAME_GAP + n
    const w = Math.min(full, inner)
    return { w, nameW: w - DOT - NAME_GAP, cut: full > inner }
  })
  // Greedy lines of item indices within `width`.
  const wrap = (width: number) => {
    const rows: number[][] = []
    let used = 0
    items.forEach((it, i) => {
      const row = rows[rows.length - 1]
      if (row && used + ITEM_GAP_X + it.w <= width) {
        row.push(i)
        used += ITEM_GAP_X + it.w
      } else {
        rows.push([i])
        used = it.w
      }
    })
    return rows
  }
  let rows = wrap(inner)
  if (rows.length > 1) {
    const count = rows.length
    let lo = Math.max(...items.map((it) => it.w))
    let hi = inner
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (wrap(mid).length <= count) hi = mid
      else lo = mid
    }
    rows = wrap(hi)
  }
  const dots: OpenLayout["dots"] = []
  let widest = 0
  rows.forEach((row, r) => {
    let x = OPEN_PAD_X
    for (const i of row) {
      dots[i] = { x, y: OPEN_PAD_Y + r * (16 + ITEM_GAP_Y) + (16 - DOT) / 2, nameW: items[i].nameW, cut: items[i].cut }
      x += items[i].w + ITEM_GAP_X
    }
    widest = Math.max(widest, x - ITEM_GAP_X)
  })
  return {
    w: Math.ceil(widest + OPEN_PAD_X),
    h: 2 * OPEN_PAD_Y + rows.length * 16 + (rows.length - 1) * ITEM_GAP_Y,
    dots,
  }
}
