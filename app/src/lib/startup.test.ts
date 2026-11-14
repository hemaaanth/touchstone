// startProgress: what the start view shows before the agent session opens.
// Runs with `bun test src/lib`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { startProgress } from "./startup"

const view = (evs: Record<string, unknown>[]) => startProgress(evs.map((e) => ({ ev: "", ...e })))

test("no events yet: one running scan row, no tool counts", () => {
  const p = view([{ ev: "scope" }])
  assert.deepEqual(p.stages, [{ key: "scan", label: "Running the tool scan", state: "running" }])
  assert.equal(p.tools, 0)
  assert.equal(p.leads, null)
})

test("a web run shows the lab, the running scanners, then the counts", () => {
  const started = view([
    { ev: "web-lab-started", image: "x", alias: "y" },
    { ev: "web-scan-started", engines: ["zap", "nuclei", "dalfox"] },
  ])
  assert.deepEqual(
    started.stages.map((s) => [s.key, s.state, s.detail]),
    [
      ["target", "done", undefined],
      ["scan", "running", "zap, nuclei, dalfox"],
    ],
  )
  const done = view([
    { ev: "web-lab-started" },
    { ev: "web-scan-started", engines: ["zap", "nuclei", "dalfox"] },
    { ev: "web-scan-done", coverage: ["zap:ran:4", "nuclei:ran:1", "dalfox:unavailable:0"], leads: 5 },
  ])
  const scan = done.stages.find((s) => s.key === "scan")!
  assert.equal(scan.state, "done")
  assert.equal(scan.detail, "2 of 3 tools ran · 5 leads")
  assert.equal(done.tools, 3)
  assert.equal(done.ran, 2)
  assert.equal(done.leads, 5)
})

test("a scan where no tool ran is a failure, not a clean result", () => {
  const p = view([{ ev: "web-scan-done", coverage: ["zap:unavailable:0", "nuclei:unavailable:0"], leads: 0 }])
  assert.equal(p.stages.find((s) => s.key === "scan")!.state, "failed")
  assert.equal(p.ran, 0)
})

test("a scan error shows no error text", () => {
  const p = view([{ ev: "web-scan-failed", error: "token=SECRET" }])
  assert.ok(!JSON.stringify(p).includes("SECRET"))
  assert.equal(p.stages.find((s) => s.key === "scan")!.state, "failed")
})

test("contracts: static and fuzz rows add up the leads", () => {
  const p = view([
    { ev: "static-scan", engines: ["Slither", "Aderyn"], suspects: 3 },
    { ev: "fuzz-scan", engines: ["Echidna"], suspects: 1 },
  ])
  assert.equal(p.leads, 4)
  assert.equal(p.tools, 3)
  // The fold has not arrived, so the scan still shows as running.
  assert.equal(p.stages.at(-1)!.state, "running")
})

test("after the summary the agent session is starting; after opened nothing runs", () => {
  const before = view([
    { ev: "web-scan-started", engines: ["zap"] },
    { ev: "prepass", total: 7, tools: [{ name: "zap", status: "ran" }, { name: "nuclei", status: "unavailable" }], leads: [] },
  ])
  assert.deepEqual(
    before.stages.map((s) => [s.key, s.state]),
    [
      ["scan", "done"],
      ["session", "running"],
    ],
  )
  assert.equal(before.leads, 7)
  assert.equal(before.tools, 2)
  assert.equal(before.ran, 1)
  const after = view([{ ev: "prepass", total: 0, tools: [] }, { ev: "opened", mode: "run" }])
  assert.ok(after.stages.every((s) => s.state !== "running"))
})

test("joined progress keeps a failed web scan separate from later domain leads", () => {
  const p = view([
    { ev: "packs", packs: ["web", "domains", "surface"] },
    { ev: "web-scan-failed", error: "SECRET" },
    { ev: "web-scan-done", coverage: ["strix:unavailable:0"], leads: 0 },
    { ev: "domains-capture-start", domain: "allowed.test" },
    { ev: "domains-prepass-done", leads: 5 },
    { ev: "surface-capture-start", domain: "allowed.test" },
  ])
  assert.equal(p.partial, true)
  assert.equal(p.leads, 5)
  assert.equal(p.stages.find((s) => s.key === "web:scan")!.state, "failed")
  assert.equal(p.stages.find((s) => s.key === "domains:scan")!.state, "done")
  assert.equal(p.stages.find((s) => s.key === "surface:capture")!.state, "running")
  assert.ok(!JSON.stringify(p).includes("SECRET"))
})

test("module reports count separate tool executions and sum leads without counting a report twice", () => {
  const p = view([
    { ev: "packs", packs: ["web", "domains", "surface"] },
    { ev: "web-scan-done", coverage: ["nuclei:ran:2"], leads: 2 },
    { ev: "module-prepass", pack: "web", total: 2, tools: [{ name: "nuclei", status: "ran" }] },
    { ev: "domains-prepass-done", leads: 5 },
    { ev: "module-prepass", pack: "domains", total: 5, tools: [{ name: "httpx", status: "ran" }] },
    { ev: "surface-prepass-done", leads: 3 },
    { ev: "module-prepass", pack: "surface", total: 3, tools: [{ name: "httpx", status: "ran" }] },
  ])
  assert.equal(p.tools, 3)
  assert.equal(p.ran, 3)
  assert.equal(p.leads, 10)
})

test("a joined final summary uses full tool totals even when the detail list is bounded", () => {
  const p = view([{ ev: "prepass", total: 10, tools: [{ name: "httpx", pack: "domains", status: "ran" }], toolsTotal: 33, toolsRan: 30 }])
  assert.equal(p.tools, 33)
  assert.equal(p.ran, 30)
  assert.equal(p.partial, false)
})

test("strix stopped at its turn cap is done, with its leads and the reason", () => {
  const running = view([{ ev: "web-strix-started", turns: 15 }])
  const r = running.stages.find((s) => s.key === "strix")!
  assert.equal(r.state, "running")
  assert.equal(r.detail, "up to 15 turns")
  const p = view([
    { ev: "web-strix-started", turns: 15 },
    { ev: "web-strix-done", status: "timed-out", leads: 3, reason: "stopped at the 15-turn cap; leads found before that are kept" },
  ])
  const s = p.stages.find((st) => st.key === "strix")!
  assert.equal(s.state, "done")
  assert.equal(s.detail, "3 leads · stopped at the 15-turn cap")
  const none = view([{ ev: "web-strix-done", status: "unavailable", leads: 0, reason: "no provider key for strix's model calls" }])
  assert.equal(none.stages.find((st) => st.key === "strix")!.state, "unavailable")
})
