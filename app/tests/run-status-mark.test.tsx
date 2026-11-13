import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RunStatusMark } from "../src/components/assistant-ui/elements/indicators"
import { headMarkKind, runMarkKind, type RunMarkKind } from "../src/components/thread-model"

// One status mark, one box for every state, so a title never moves.
const KINDS: RunMarkKind[] = ["starting", "working", "replaying", "paused", "proven", "done", "failed"]
const html = (kind: RunMarkKind) => renderToStaticMarkup(<RunStatusMark kind={kind} label="x" />)
// The size class of the mark's outer box.
const box = (h: string) => /^<span[^>]*class="([^"]*)"/.exec(h)?.[1]?.split(" ").filter((c) => /^size-/.test(c))

describe("RunStatusMark", () => {
  test("every state renders the same box", () => {
    for (const k of KINDS) {
      expect(html(k)).toContain('data-slot="run-status-mark"')
      expect(box(html(k))).toEqual(["size-3.5"])
    }
  })

  test("each state has its own simple shape, in restraint's colours", () => {
    // Working moves, quietly; reduced motion stills it.
    expect(html("working")).toContain("animate-pulse")
    expect(html("working")).toContain("motion-reduce:animate-none")
    // Settled states hold still.
    for (const k of ["starting", "paused", "proven", "done", "failed"] as RunMarkKind[]) {
      expect(html(k)).not.toContain("animate-")
    }
    // Green only for proven. An error is the warning tone, never red.
    expect(html("proven")).toContain("text-ok")
    expect(html("failed")).toContain("text-warn")
    for (const k of KINDS) expect(html(k)).not.toMatch(/(text|bg|border)-(bad|destructive|red-)/)
    for (const k of KINDS.filter((k) => k !== "proven")) expect(html(k)).not.toContain("text-ok")
    // Shapes a reader can tell apart: the working dot is the only solid dot.
    const shapes = new Set(["starting", "working", "paused", "proven", "done", "failed"].map((k) => html(k as RunMarkKind).replace(/ animate-pulse| motion-reduce:animate-none|data-mark="[a-z]+"/g, "")))
    expect(shapes.size).toBe(6)
  })

  test("it names the state for a screen reader, unless hidden", () => {
    expect(html("proven")).toContain('aria-label="x"')
    expect(renderToStaticMarkup(<RunStatusMark aria-hidden kind="proven" label="x" />)).not.toContain("aria-label")
  })

  test("a run's status maps to one mark", () => {
    expect(runMarkKind({ status: "starting" })).toBe("starting")
    expect(runMarkKind({ status: "running" })).toBe("working")
    expect(runMarkKind({ status: "deciding" })).toBe("replaying")
    expect(runMarkKind({ status: "awaiting-approval" })).toBe("replaying")
    expect(runMarkKind({ status: "recorded" })).toBe("proven")
    expect(runMarkKind({ status: "no-finding" })).toBe("done")
    expect(runMarkKind({ status: "denied" })).toBe("failed")
    expect(runMarkKind({ status: "error" })).toBe("failed")
    expect(runMarkKind({ status: "error", errorKind: "cutoff" })).toBe("paused")
  })

  test("the top bar's status maps to the same marks", () => {
    expect(headMarkKind({ word: "Running", tone: "working" })).toBe("working")
    expect(headMarkKind({ word: "Proven", tone: "proven" })).toBe("proven")
    expect(headMarkKind({ word: "Failed", tone: "failed" })).toBe("failed")
    expect(headMarkKind({ word: "Interrupted", tone: "neutral" })).toBe("paused")
    expect(headMarkKind({ word: "Stopped", tone: "neutral" })).toBe("paused")
    expect(headMarkKind({ word: "No finding", tone: "neutral" })).toBe("done")
  })
})
