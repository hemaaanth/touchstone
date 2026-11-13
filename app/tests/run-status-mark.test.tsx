import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RunStatusMark } from "../src/components/assistant-ui/elements/indicators"
import { headMarkKind, runMarkKind, type RunMarkKind } from "../src/components/thread-model"

// One status mark, one box for every state, so a title never moves.
const KINDS: RunMarkKind[] = ["starting", "working", "replaying", "paused", "proven", "done", "failed"]
const html = (kind: RunMarkKind) => renderToStaticMarkup(<RunStatusMark kind={kind} label="x" />)
// The size class of the mark's outer box.
const box = (h: string) => /<span[^>]*data-slot="dot-matrix"[^>]*class="([^"]*)"|<span[^>]*class="([^"]*)"[^>]*data-slot="dot-matrix"/.exec(h)?.slice(1).find(Boolean)?.split(" ").filter((c) => /^size-/.test(c))

describe("RunStatusMark", () => {
  test("every state renders the same box", () => {
    const boxes = KINDS.map((k) => box(html(k)))
    for (const b of boxes) expect(b).toEqual(["size-3.5"])
  })

  test("each state is the dot-matrix element, with restraint's colours", () => {
    expect(html("working")).toContain('data-state="thinking"')
    expect(html("proven")).toContain("text-ok")
    expect(html("failed")).toContain("text-bad")
    // Working, starting and replaying are neutral: no red or green.
    for (const k of ["working", "starting", "replaying", "paused", "done"] as RunMarkKind[]) {
      expect(html(k)).not.toMatch(/text-(ok|bad)\b/)
    }
    // Under reduced motion the dots hold still.
    expect(html("working")).toContain("motion-reduce:[animation-name:none]")
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
