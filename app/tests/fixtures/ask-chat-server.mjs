// Run with bun --no-env-file. All output/cache/state stays under the explicitly
// supplied private ASK_FIXTURE_DIR; dependencies are installed, read-only files.
import { readFileSync, readdirSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { compile } from "@tailwindcss/node"
import { createRoamControlApi } from "../../server/roam-control.mjs"

const directory = process.env.ASK_FIXTURE_DIR
const deps = process.env.ASK_FIXTURE_DEPS
if (!directory || !deps || process.env.HOME !== directory || process.env.TMPDIR !== directory) throw Error("Explicit private fixture environment required")
mkdirSync(directory, { recursive: true })
const app = fileURLToPath(new URL("../../", import.meta.url))
const bundle = await Bun.build({ entrypoints: [join(app, "tests/fixtures/ask-chat.tsx")], outdir: join(directory, "bundle"), target: "browser", minify: false, define: { "process.env.NODE_ENV": JSON.stringify("development") } })
if (!bundle.success) throw new AggregateError(bundle.logs, "Fixture bundle failed")
const sheet = readFileSync(join(app, "src/index.css"), "utf8").replaceAll('"./fonts.css"', JSON.stringify(join(app, "src/fonts.css"))).replaceAll('"./tokens.css"', JSON.stringify(join(app, "src/tokens.css")))
const styles = await compile(sheet, { base: join(deps, "..", "src"), onDependency() {} })
const candidates = []
function scan(path) {
  for (const item of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, item.name)
    if (item.isDirectory()) scan(file)
    else if (/\.(tsx?|css)$/.test(item.name)) candidates.push(...readFileSync(file, "utf8").split(/[\s"'`]+/))
  }
}
scan(join(app, "src"))
const css = styles.build(candidates)
const streams = new Set()
let held = [], mode = "http-first", lines = [], control, run, failedOnce = false
const broadcast = (event) => {
  run.events.push(event)
  if (mode === "http-first" && ["ask-answered", "ask-receipt"].includes(event.ev)) held.push(event)
  else for (const stream of streams) stream.enqueue(`data: ${JSON.stringify(event)}\n\n`)
}
const reset = (next) => {
  control?.invalidate(run).catch(() => {})
  mode = next; held = []; lines = []; failedOnce = false
  run = { id: "fixture", alias: "fixture", model: "fixture", mode: "fleet", owner: {}, status: "running", roamEpoch: "synthetic-epoch", events: [
    { ev: "status", status: "running" }, { ev: "mode", mode: "fleet" },
    { ev: "subagent-spawned", id: "a-1", name: "Scout", title: "Source checks", loadout: "free-roam", model: "fixture", t: 1 },
    { ev: "subagent-spawned", id: "a-2", name: "Reviewer", title: "Review checks", loadout: "free-roam", model: "fixture", t: 1 },
    { ev: "assistant-delta", conv: "root", attempt: 1, text: "Before the question." },
  ] }
  const child = { stdin: { writable: true, write(raw, cb) {
    if (mode === "presend" && !failedOnce) { failedOnce = true; throw Error("Synthetic pre-send refusal") }
    const line = JSON.parse(raw); lines.push(line); cb?.()
    if (line.ask && mode !== "uncertain") queueMicrotask(() => control.consume(run, child, run.roamEpoch, { ev: "ask-answered", id: line.ask, agent: run.events.find((e) => e.ev === "ask-human" && e.id === line.ask).agent, answer: "reply" in line ? "reply" : line.done ? "done" : "cancel" }))
  } } }
  run.child = child
  control = createRoamControlApi({ getRun: () => run, emit: (_, e) => broadcast(e), machine: async () => { throw Error("Desktop network forbidden") }, timeoutMs: 100 })
  control.begin(run, child, run.roamEpoch)
  const options = [{ id: "source", label: "Inspect source", description: "Read the selected source" }, { id: "tests", label: "Run isolated tests" }, { id: "unicode", label: "確認 · Unicode long choice wraps without widening the conversation" }]
  control.consume(run, child, run.roamEpoch, { ev: "ask-human", id: "root-q", agent: "coordinator", kind: "question", question: "Which check should I run?", presentation: { options, select: "single" } })
  broadcast({ ev: "assistant-delta", conv: "root", attempt: 2, text: "After the question." })
  control.consume(run, child, run.roamEpoch, { ev: "ask-human", id: "child-q1", agent: "a-1", kind: "question", question: "Choose two checks for the source.", presentation: { options, select: "multiple", min: 2, max: 2 } })
  control.consume(run, child, run.roamEpoch, { ev: "ask-human", id: "child-q2", agent: "a-2", kind: "login", question: "Which test environment should I use?" })
}
reset("http-first")
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url)
  if (url.pathname === "/") return new Response('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } })
  if (url.pathname === "/fixture.js") return new Response(Bun.file(join(directory, "bundle/ask-chat.js")), { headers: { "content-type": "text/javascript" } })
  if (url.pathname === "/fixture.css") return new Response(css, { headers: { "content-type": "text/css" } })
  if (url.pathname.startsWith("/fonts/")) return new Response("", { status: 404 })
  if (url.pathname === "/fixture/status") return Response.json({ mode, lines, held: held.length })
  if (url.pathname === "/fixture/reset" && request.method === "POST") { reset((await request.json()).mode); return Response.json({ ok: true }) }
  if (url.pathname === "/fixture/flush" && request.method === "POST") { for (const event of held) for (const stream of streams) stream.enqueue(`data: ${JSON.stringify(event)}\n\n`); held = []; return Response.json({ ok: true }) }
  if (url.pathname === "/fixture/ack" && request.method === "POST") { const line = lines.find((x) => x.ask); control.consume(run, run.child, run.roamEpoch, { ev: "ask-answered", id: line.ask, agent: run.events.find((e) => e.id === line.ask).agent, answer: "reply" }); return Response.json({ ok: true }) }
  if (url.pathname === "/api/runs/fixture") return Response.json({ ...run, owner: undefined, child: undefined, startedAt: 1, candidates: [], findings: [] })
  if (url.pathname === "/api/runs/fixture/stream") return new Response(new ReadableStream({ start(controller) { streams.add(controller); for (const event of run.events.slice(Number(url.searchParams.get("since")))) controller.enqueue(`data: ${JSON.stringify(event)}\n\n`) }, cancel() { streams.clear() } }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } })
  if (url.pathname === "/api/runs/fixture/ask" && request.method === "POST") {
    try {
      const result = await control.answer("fixture", await request.json())
      if (mode === "sse-first") await Bun.sleep(1500)
      if (mode === "lost-http") return Response.json({ error: "Response lost after accepted answer", delivery: "unknown" }, { status: 503 })
      return Response.json(result)
    } catch (error) { return Response.json({ error: error.message, delivery: error.delivery === "not-sent" ? "not-sent" : "unknown" }, { status: 409 }) }
  }
  return new Response("Synthetic fixture: route unavailable", { status: 404 })
} })
console.log(JSON.stringify({ port: server.port, pid: process.pid, directory: resolve(directory) }))
