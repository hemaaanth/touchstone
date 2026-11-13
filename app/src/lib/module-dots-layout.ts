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
  return room >= MIN_OPEN_W ? room : Math.min(MIN_OPEN_W, viewportWidth - 2 * EDGE)
}

// The open pill's left edge: the mark's own, unless the pill would cross the
// screen's right edge; then just far enough left to fit.
export function pillLeft(markLeft: number, openWidth: number, viewportWidth: number): number {
  return Math.max(EDGE, Math.min(markLeft, viewportWidth - EDGE - openWidth))
}
