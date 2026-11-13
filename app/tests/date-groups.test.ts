import { describe, expect, test } from "bun:test"
import { dateGroups, startMs } from "../src/components/thread-model"

// The run list's date headings. Each heading shows once, newest first, even
// when a start time arrives as an ISO string instead of epoch ms.
const today = new Date(2026, 10, 13).getTime()
const H = 3600_000

describe("dateGroups", () => {
  test("an ISO start time sorts and groups like a number: one Earlier heading", () => {
    const times = [
      new Date(today - 30 * H).toISOString(), // two days back, as a string
      today + 2 * H,
      today - 40 * H,
      today - 20 * H,
    ]
    const groups = dateGroups(times, [0, 1, 2, 3], today)
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "Earlier"])
    expect(groups.map((g) => g.indices)).toEqual([[1], [3], [0, 2]])
  })

  test("startMs reads numbers and dates, and nothing else", () => {
    expect(startMs(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(startMs("1700000000000")).toBe(1_700_000_000_000)
    expect(startMs("2026-11-13T00:00:00.000Z")).toBe(Date.parse("2026-11-13T00:00:00.000Z"))
    for (const v of [undefined, null, 0, NaN, "", "soon", {}]) expect(startMs(v)).toBeUndefined()
  })
})
