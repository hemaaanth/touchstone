import { describe, expect, test } from "bun:test"
import { pipelineModules } from "../src/lib/pipeline"
import { reduceEvents } from "../src/lib/runModel"

const scan = { ev: "static-scan", engines: ["Slither", "Aderyn"], analysed: 1, failed: 0, suspects: 2, top: [{ corroborated: true }, { corroborated: false }] }
const attempt = { ev: "run_poc", contract: "ExploitTest" }

describe("run pipeline evidence", () => {
  test("an absent event never means ran, off, clean or proven", () => {
    const modules = pipelineModules(reduceEvents([]))
    expect(modules.map((m) => m.status)).toEqual(["No event", "No event", "No event", "No event"])
    expect(modules.some((m) => m.passed)).toBe(false)
  })

  test("scan agreement ranks leads, but does not pass the proof gate", () => {
    const modules = pipelineModules(reduceEvents([scan]))
    expect(modules[0].status).toBe("Ran · 2 leads")
    expect(modules[0].detail).toBe("Slither + Aderyn")
    expect(modules[0].evidence).toContain("1 of the top 2 leads")
    expect(modules[0].agreement).toBe("Agreement on 1/2 top leads")
    expect(modules[3].passed).toBe(false)
  })

  test("only reported engines are displayed after a scan", () => {
    expect(pipelineModules(reduceEvents([{ ...scan, engines: ["Slither"] }]))[0].detail).toBe("Slither")
  })

  test("zero leads require scan evidence and never read as clean", () => {
    expect(pipelineModules(reduceEvents([{ ...scan, suspects: 0, top: [] }]))[0].status).toBe("Ran · 0 leads")
    expect(pipelineModules(reduceEvents([{ ...scan, engines: [] }]))[0].status).toBe("Inconclusive")
    expect(pipelineModules(reduceEvents([{ ...scan, analysed: 0, failed: 1 }]))[0].status).toBe("Inconclusive")
    expect(pipelineModules(reduceEvents([{ ...scan, failed: 1 }]))[0].status).toBe("Partial · 2 leads")
  })

  test("fuzz off requires an explicit non-applicable event", () => {
    const modules = pipelineModules(reduceEvents([{ ev: "fuzz-scan", engines: [], applicable: false, suspects: 0, top: [] }]))
    expect(modules[1].status).toBe("Off")
    expect(modules[1].detail).toBe("No fuzz template")
    expect(modules[1].evidence).toContain("did not run")
  })

  test("a module plan distinguishes selected from executed, and carries off reasons", () => {
    const plan = { ev: "modules", modules: [{ id: "static", on: false, reason: "No local source" }, { id: "fuzz", on: true }] }
    const modules = pipelineModules(reduceEvents([plan]))
    expect(modules[0].status).toBe("Off")
    expect(modules[0].evidence).toContain("No local source")
    expect(modules[1].status).toBe("Selected")
    expect(modules[1].evidence).toContain("no execution event")
    expect(pipelineModules(reduceEvents([plan, scan]))[0].status).toBe("Ran · 2 leads")
  })

  test("opening an agent session is not evidence of agent tool work", () => {
    expect(pipelineModules(reduceEvents([{ ev: "opened", mode: "run" }]))[2].status).toBe("Started")
    expect(pipelineModules(reduceEvents([{ ev: "opened", mode: "decide" }]))[2].status).toBe("No event")
    expect(pipelineModules(reduceEvents([{ ev: "read_source", file: "Target.sol" }]))[2].status).toBe("Ran")
  })

  test("a brief's fetch appears only with plan or execution evidence, and never passes the gate", () => {
    const plan = { ev: "modules", modules: [{ id: "fetch", on: true }] }
    const fetch = { ev: "fetch_source", url: "https://example.com/source.sol" }
    const done = { ev: "fetch_source-done", ok: true }
    const module = (events: Parameters<typeof reduceEvents>[0]) => pipelineModules(reduceEvents(events)).find((m) => m.label === "Source fetch")
    expect(module([])).toBeUndefined()
    expect(module([plan])?.status).toBe("Selected")
    expect(module([fetch])?.status).toBe("Fetching")
    expect(module([fetch, done])?.status).toBe("Ran")
    expect(module([fetch, done, fetch])?.status).toBe("Fetching")
    expect(module([fetch, { ...done, ok: false }])?.status).toBe("Failed")
    expect(pipelineModules(reduceEvents([fetch, done])).at(-1)?.passed).toBe(false)
  })

  test("replay goes green only on a matching passing result", () => {
    expect(pipelineModules(reduceEvents([attempt]))[3].status).toBe("Running")
    expect(pipelineModules(reduceEvents([attempt, { ev: "closed" }]))[3].status).toBe("Incomplete")
    expect(pipelineModules(reduceEvents([attempt, { ev: "run_poc-done", contract: "OtherTest", passed: true }]))[3].passed).toBe(false)
    expect(pipelineModules(reduceEvents([attempt, { ev: "run_poc-done", contract: "ExploitTest", passed: false }]))[3].status).toBe("Not passed")
    expect(pipelineModules(reduceEvents([attempt, { ev: "run_poc-done", contract: "ExploitTest", passed: true }]))[3].passed).toBe(true)
  })
})
