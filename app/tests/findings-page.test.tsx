import "./helpers/isolated-env"
import { describe, expect, mock, test } from "bun:test"
import * as fsp from "node:fs/promises"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import type { FindingSummary } from "../src/lib/types"

// The Findings page (F1, F2). Server: the list fields, the module of each
// finding, the honest proof state, and the copied texts (built and redacted by
// the server). Browser: the default order, the filters, 500 rows, and the
// colours of a row. Every record and secret here is synthetic, and the
// records live only in this test (mocked reads), never in the data folder.

// ── Synthetic records ───────────────────────────────────────────────────────

const TOKEN = "tk_live_9fakeZq7Xv9KpR2mN4tW8yB3"
const COOKIE = "sess9fakeQ2w3e4r5t6y7u8i9o0pLk"
const PEM_BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC" + "Fake".repeat(60)
const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`
const SECRETS = [TOKEN, COOKIE, PEM_BODY.slice(0, 32)]

const STARTED = Date.UTC(2026, 10, 12, 9, 30)
const MULTI = "zz-fp-2611120930-1" // several modules, secrets in the record
const NO_REPLAY = "zz-fp-2611120931-1" // a forge finding with no replay record
const FAILED = "zz-fp-2611120932-1" // a forge proof that failed its replay
const DAMAGED = "zz-fp-2611120933-1" // not JSON
const LONG = "zz-fp-2611120934-1" // a narrative over the 64 KB redaction cap
const SPLIT = "zz-fp-2611120935-1" // a key that is whole only once the brief is assembled

const records: Record<string, string> = {
  [`run-${MULTI}.json`]: JSON.stringify({
    result: {
      pack: "web",
      target: { title: "Synthetic lab", entry: "app/server.js" },
      findings: [
        {
          title: "Debug route leaks the session token",
          severity: "high",
          pack: "web",
          pocProved: true,
          explanation:
            `The debug route answers with Authorization: Bearer ${TOKEN} to anyone. ` +
            `It also sets Cookie: session=${COOKIE} on the reply. ` +
            `The body quotes the signer key ${PEM}. Nobody has to log in.\n\n` +
            "Fix: remove the route.",
          proof: {
            kind: "http",
            status: "pass",
            // KNOWN GAP (server/redact.mjs, not this page): a bare value in prose
            // after the word "token" ("returned token tk_…") matches no rule and
            // stays in the Markdown report. Here the value carries its header.
            oracle: { name: "debug-route-signer-key-leak", detail: `the reply held Authorization: Bearer ${TOKEN}` },
            log: [
              {
                label: "1. GET /debug",
                request: { method: "GET", url: `http://lab:8080/debug?token=${TOKEN}`, headers: { cookie: `session=${COOKIE}` } },
                response: { status: 200, body: JSON.stringify({ token: TOKEN, privateKey: PEM }) },
              },
            ],
          },
        },
        { title: "Lookalike domain", severity: "low", pack: "domains", proof: { kind: "evidence", status: "fail" } },
        { title: "Script without SRI", severity: "medium", pocProved: true, proof: { kind: "evidence", status: "pass", check: "cdn-without-sri" } },
      ],
    },
  }),
  [`run-${MULTI}.events`]: `${JSON.stringify({ t: STARTED, ev: "status" })}\n${JSON.stringify({ t: STARTED + 5000, ev: "say" })}\n`,
  // The engine says pocProved, but there is no proof and no replay in the transcript.
  [`run-${NO_REPLAY}.json`]: JSON.stringify({ result: { finding: { title: "Claimed reentrancy", severity: "critical", poc: "XTest" }, pocProved: true } }),
  [`run-${FAILED}.json`]: JSON.stringify({
    result: { finding: { title: "Replay failed", severity: "critical", poc: "YTest" }, pocProved: true, proof: { pass: false, status: "fail", contract: "YTest", transfers: [] } },
  }),
  [`run-${DAMAGED}.json`]: '{"result": {"finding": {"title": "Torn',
  // The key's BEGIN line is in the title and its body and END line in the
  // narrative. Each field alone holds no whole key, so the report's own pass
  // leaves both; only the pass over the assembled brief can see the key.
  [`run-${SPLIT}.json`]: JSON.stringify({
    result: {
      findings: [
        {
          title: "Key dump -----BEGIN PRIVATE KEY-----",
          severity: "high",
          pocProved: true,
          explanation: `${PEM_BODY} -----END PRIVATE KEY----- came back from the debug route`,
          proof: { kind: "http", status: "pass", oracle: { name: "debug-route-signer-key-leak" } },
        },
      ],
    },
  }),
  [`run-${LONG}.json`]: JSON.stringify({
    result: {
      findings: [{ title: "Huge write-up", severity: "low", pocProved: true, explanation: `Key ${TOKEN}. ` + "The vault pays twice. ".repeat(4000), proof: { kind: "http", status: "pass", oracle: { name: "bola-wallet-idor" } } }],
    },
  }),
}

// The events file is read by its head through open(): give it a real file.
const dir = mkdtempSync(path.join(tmpdir(), "findings-page-test-"))
const eventsFile = path.join(dir, "events")
writeFileSync(eventsFile, records[`run-${MULTI}.events`])

const real = { ...fsp }
const ours = (file: string) => path.basename(String(file)) in records
mock.module("node:fs/promises", () => ({
  ...real,
  readdir: async (d: string, ...rest: unknown[]) =>
    path.basename(String(d)) === "agent" ? [...(await real.readdir(d).catch(() => [])), ...Object.keys(records)] : real.readdir(d, ...(rest as [])),
  readFile: async (file: string, ...rest: unknown[]) => (ours(file) ? records[path.basename(String(file))] : real.readFile(file, ...(rest as []))),
  open: async (file: string, ...rest: unknown[]) =>
    path.basename(String(file)) === `run-${MULTI}.events` ? real.open(eventsFile, "r") : real.open(file, ...(rest as [])),
}))

// @ts-expect-error — plain .mjs module, no types
const { listFindings } = await import("../server/findings.mjs")
// @ts-expect-error — plain .mjs module, no types
const { handleFindings } = await import("../server/runs-http.mjs")
// @ts-expect-error — plain .mjs module, no types
const { handleApi } = await import("../server/api.mjs")

type Listed = FindingSummary & { pack: string | null; scope: string | null; at: number | null }
const listed = async (): Promise<Listed[]> => ((await listFindings()) as Listed[]).filter((f) => f.id.startsWith("zz-fp-"))

// GET a report route through the real handler, as the console page does.
async function getReport(id: string, format: string): Promise<{ status: number; type: string; body: string }> {
  let status = 0
  let type = ""
  let body = ""
  const req = { url: `/api/findings/${encodeURIComponent(id)}/report?format=${format}`, method: "GET", headers: { host: "localhost:5233" } }
  const res = {
    set statusCode(v: number) {
      status = v
    },
    get statusCode() {
      return status
    },
    setHeader: (k: string, v: string) => {
      if (k.toLowerCase() === "content-type") type = v
    },
    end: (s?: string) => {
      body = s ?? ""
    },
  }
  expect(await handleFindings(req, res)).toBe(true)
  return { status, type, body }
}

describe("findings list (server): the fields a row needs", () => {
  test("a finding's module is its own pack, else the run's pack", async () => {
    const rows = await listed()
    const by = (t: string) => rows.find((f) => f.title === t)!
    expect(by("Debug route leaks the session token").pack).toBe("web")
    expect(by("Lookalike domain").pack).toBe("domains")
    // N3: an evidence replay repeats a measurement, so this row is a candidate
    // now (listCandidates), with the run's pack, and not in the findings list.
    expect(rows.some((f) => f.title === "Script without SRI")).toBe(false)
    // @ts-expect-error — plain .mjs module, no types
    const { listCandidates } = await import("../server/findings.mjs")
    const c = (await listCandidates()).find((x: { runId: string }) => x.runId === MULTI)
    expect([c.title, c.pack, c.origin, c.proven]).toEqual(["Script without SRI", "web", "measured", false])
  })

  test("the scope and the run start come from the run", async () => {
    const rows = await listed()
    const multi = rows.filter((f) => f.runId === MULTI)
    expect(multi).toHaveLength(2)
    for (const f of multi) {
      expect(f.scope).toBe("Synthetic lab")
      expect(f.at).toBe(STARTED)
    }
    // No events file: the date is not recorded. The file's own date is not used.
    expect(rows.find((f) => f.runId === NO_REPLAY)!.at).toBeNull()
  })

  test("proof state is honest: no replay record, a failed replay, or a damaged record is never proven", async () => {
    const rows = await listed()
    const by = (t: string) => rows.find((f) => f.title === t)!
    expect(by("Debug route leaks the session token").proven).toBe(true)
    expect(by("Lookalike domain").proven).toBe(false)
    expect(by("Claimed reentrancy").proven).toBe(false)
    expect(by("Replay failed").proven).toBe(false)
    // A record that is not JSON shows nothing, never a finding.
    expect(rows.some((f) => f.runId === DAMAGED)).toBe(false)
  })
})

describe("copied texts (server): built by the report builder and redacted", () => {
  const id = `${MULTI}.1`

  test("Copy for an agent: the short brief, with no secret", async () => {
    const { status, type, body } = await getReport(id, "agent")
    expect(status).toBe(200)
    expect(type).toContain("text/plain")
    for (const s of SECRETS) expect(body).not.toContain(s)
    expect(body).toContain("Finding: Debug route leaks the session token")
    expect(body).toContain("Severity: high")
    expect(body).toContain("State: Proven by a replay.")
    expect(body).toContain("Where: GET http://lab:8080/debug?token=[REDACTED]")
    expect(body).toMatch(/^What is wrong: The debug route answers with Authorization: Bearer \[REDACTED\]/m)
    expect(body).toContain('How it was proven: An HTTP replay; the oracle "debug-route-signer-key-leak" fired.')
    expect(body).toContain("Fix hint: remove the route.")
    // A short form: no chat history, no proof record.
    expect(body.split("\n").length).toBeLessThanOrEqual(8)
    expect(body).not.toContain("exchanges")
  })

  test("Copy report (Markdown): the full report, with no secret", async () => {
    const { status, type, body } = await getReport(id, "md")
    expect(status).toBe(200)
    expect(type).toContain("text/markdown")
    expect(body).toContain("# Debug route leaks the session token")
    for (const s of SECRETS) expect(body).not.toContain(s)
  })

  test("an unproven finding says so in the brief", async () => {
    const { body } = await getReport(`${MULTI}.2`, "agent")
    expect(body).toContain("State: Not proven. A lead, not a replayed proof.")
    expect(body).toMatch(/^How it was proven: Not proven\./m)
    const forge = await getReport(NO_REPLAY, "agent")
    expect(forge.body).toContain("State: Not proven.")
  })

  test("a text over the redaction cap carries the mark the page names", async () => {
    const { TOO_LONG } = await import("../src/lib/findings-view")
    for (const format of ["agent", "md"]) {
      const { body } = await getReport(`${LONG}.1`, format)
      expect(body).toMatch(TOO_LONG)
      expect(body).not.toContain(TOKEN)
    }
  })

  test("the agent brief is redacted again once assembled: a key split across the title and the narrative", async () => {
    const { body } = await getReport(`${SPLIT}.1`, "agent")
    expect(body).not.toContain(PEM_BODY.slice(0, 32))
    expect(body).toContain("[REDACTED]")
  })

  test("an unknown finding is a 404", async () => {
    expect((await getReport("zz-fp-none", "agent")).status).toBe(404)
  })
})

// ── Browser side ────────────────────────────────────────────────────────────

const { DEFAULT_VIEW, filterFindings, isFiltered, sortFindings } = await import("../src/lib/findings-view")
const { FindingListRow } = await import("../src/components/findings-page")

const SEV = ["critical", "high", "medium", "low", "informational"] as const
const SCOPES = ["FeeVault", "Web lab", "Supply chain lab", "Vault"]
const PACKS = ["contracts", "web", "supply-chain", "domains"]
// 500 synthetic rows, spread over 60 days, every fifth one not proven.
const DAY = 86_400_000
const BASE = Date.UTC(2026, 8, 1, 12)
const many: FindingSummary[] = Array.from({ length: 500 }, (_, i) => ({
  id: `syn-${i}`,
  runId: `run-${i % 40}`,
  title: `Synthetic finding ${i} ${i % 7 === 0 ? "reentrancy" : "access control"}`,
  severity: SEV[i % SEV.length] as FindingSummary["severity"],
  module: PACKS[i % PACKS.length],
  pack: PACKS[i % PACKS.length],
  target: SCOPES[i % SCOPES.length],
  scope: SCOPES[i % SCOPES.length],
  at: i % 50 === 0 ? null : BASE + (i % 60) * DAY + i * 1000,
  stages: { hypothesis: true, reproduced: true, proven: i % 5 !== 0, accepted: false },
  proven: i % 5 !== 0,
  dismissed: false,
  ms: null,
}))
const rank = (s: string) => ({ critical: 5, high: 4, medium: 3, low: 2, informational: 1 })[s] ?? 0

describe("findings list (browser): order and filters", () => {
  test("the default order is proven first, then severity, then newest", () => {
    const out = sortFindings(many, "proven")
    for (let i = 1; i < out.length; i++) {
      const a = out[i - 1]
      const b = out[i]
      if (a.proven !== b.proven) {
        expect(a.proven).toBe(true)
        continue
      }
      const d = rank(a.severity) - rank(b.severity)
      expect(d).toBeGreaterThanOrEqual(0)
      if (d === 0) expect((a.at ?? -Infinity) >= (b.at ?? -Infinity)).toBe(true)
    }
  })

  test("each filter narrows the list; a date range drops rows with no date", () => {
    const v = { ...DEFAULT_VIEW }
    expect(isFiltered(v)).toBe(false)
    expect(filterFindings(many, v)).toHaveLength(500)
    expect(filterFindings(many, { ...v, scope: "Web lab" }).every((f) => f.scope === "Web lab")).toBe(true)
    expect(filterFindings(many, { ...v, module: "domains" }).every((f) => f.pack === "domains")).toBe(true)
    expect(filterFindings(many, { ...v, severity: "critical" }).every((f) => f.severity === "critical")).toBe(true)
    expect(filterFindings(many, { ...v, state: "unproven" })).toHaveLength(100)
    expect(filterFindings(many, { ...v, q: "REENTRANCY" }).every((f) => f.title.includes("reentrancy"))).toBe(true)
    const range = filterFindings(many, { ...v, from: "2026-09-10", to: "2026-09-12" })
    expect(range.length).toBeGreaterThan(0)
    expect(range.every((f) => f.at != null)).toBe(true)
    expect(filterFindings(many, { ...v, from: "2027-01-01" })).toHaveLength(0)
    expect(isFiltered({ ...v, to: "2026-09-12" })).toBe(true)
  })

  test("500 rows: a filter and a sort take a few milliseconds", () => {
    const t0 = performance.now()
    for (const q of ["r", "re", "ree", "reen", "reent"]) sortFindings(filterFindings(many, { ...DEFAULT_VIEW, q }), "proven")
    expect(performance.now() - t0).toBeLessThan(50)
  })
})

describe("the sheet's read (m3): the finding without its run's events", () => {
  test("?events=0 leaves the events out; the default keeps them", async () => {
    const full = await handleApi(`/api/findings/${MULTI}.1`)
    const lean = await handleApi(`/api/findings/${MULTI}.1?events=0`)
    expect(full.status).toBe(200)
    expect(lean.status).toBe(200)
    expect(full.json.events.length).toBeGreaterThan(0)
    expect(lean.json.events).toEqual([])
    // Everything the sheet shows is still there.
    const { events: _a, ...fullRest } = full.json
    const { events: _b, ...leanRest } = lean.json
    expect(leanRest).toEqual(fullRest)
  })
})

describe("dismissed findings (m4): hidden by default, last when shown", () => {
  const mixed = many.map((f, i) => (i % 10 === 3 ? { ...f, dismissed: true } : f))
  test("the default view hides them; Show dismissed brings them back", () => {
    expect(DEFAULT_VIEW.dismissed).toBe("hide")
    expect(filterFindings(mixed, DEFAULT_VIEW)).toHaveLength(450)
    expect(filterFindings(mixed, DEFAULT_VIEW).some((f) => f.dismissed)).toBe(false)
    expect(filterFindings(mixed, { ...DEFAULT_VIEW, dismissed: "show" })).toHaveLength(500)
  })
  test("every sort puts a dismissed finding after every open one", () => {
    for (const sort of ["proven", "severity", "newest", "oldest", "scope"] as const) {
      const out = sortFindings(mixed, sort)
      const firstDismissed = out.findIndex((f) => f.dismissed)
      expect(firstDismissed).toBe(450)
      expect(out.slice(firstDismissed).every((f) => f.dismissed)).toBe(true)
    }
  })
})

describe("a row: red only on a proven finding, green only after a replay", () => {
  const row = (f: FindingSummary) =>
    renderToStaticMarkup(
      <ul>
        <FindingListRow finding={f} moduleTitle="Contracts" run={undefined} active={false} onOpen={() => {}} onCopy={() => {}} onOpenRun={() => {}} />
      </ul>,
    )
  const critical = { ...many[1], severity: "critical" as const, title: "Drain" }

  test("a proven critical finding shows green proof and red severity", () => {
    const html = row({ ...critical, proven: true, stages: { ...critical.stages, proven: true } })
    expect(html).toContain("text-ok")
    expect(html).toContain("text-bad")
    expect(html).toContain("Proven")
  })

  test("an unproven critical finding is neutral: no green, no red, no amber", () => {
    const html = row({ ...critical, proven: false, stages: { ...critical.stages, proven: false } })
    expect(html).not.toContain("text-ok")
    expect(html).not.toContain("text-bad")
    expect(html).not.toContain("text-warn")
    expect(html).toContain("Not proven")
  })

  test("a dismissed proven row reads Dismissed first, then its true state", () => {
    const html = row({ ...critical, dismissed: true, proven: true, stages: { ...critical.stages, proven: true } })
    expect(html.indexOf("Dismissed")).toBeGreaterThan(-1)
    expect(html.indexOf("Dismissed")).toBeLessThan(html.indexOf(">Proven<"))
  })

  test("a row with no recorded date says so", () => {
    expect(row({ ...critical, at: null })).toContain("Date not recorded")
  })
})

// ── N2: still columns, and one date range ──────────────────────────────────

const { fromDayRange, normaliseDays, parseDay, rangeLabel, toDayRange } = await import("../src/lib/findings-view")
const { FINDING_ROW_COLS, FindingsLoading } = await import("../src/components/findings-page")

describe("the date range (one picker for the view's two days)", () => {
  const NOW = new Date(2026, 10, 13)
  const d = (y: number, m: number, day: number) => new Date(y, m - 1, day)

  test("from only: the range has a start and no end, and reads 'From …'", () => {
    expect(toDayRange("2026-11-01", "")).toEqual({ from: d(2026, 11, 1), to: undefined })
    expect(fromDayRange({ from: d(2026, 11, 1) })).toEqual({ from: "2026-11-01", to: "" })
    expect(rangeLabel("2026-11-01", "", NOW)).toBe("From Nov 1")
  })

  test("to only: the range has an end and no start, and reads 'Until …'", () => {
    expect(toDayRange("", "2026-11-13")).toEqual({ from: undefined, to: d(2026, 11, 13) })
    expect(fromDayRange({ from: undefined, to: d(2026, 11, 13) })).toEqual({ from: "", to: "2026-11-13" })
    expect(rangeLabel("", "2026-11-13", NOW)).toBe("Until Nov 13")
  })

  test("both: one range, both ways; one day reads as that day; another year carries its year", () => {
    const r = toDayRange("2026-11-01", "2026-11-13")
    expect(r).toEqual({ from: d(2026, 11, 1), to: d(2026, 11, 13) })
    expect(fromDayRange(r)).toEqual({ from: "2026-11-01", to: "2026-11-13" })
    expect(rangeLabel("2026-11-01", "2026-11-13", NOW)).toBe("Nov 1 – Nov 13")
    expect(rangeLabel("2026-11-13", "2026-11-13", NOW)).toBe("Nov 13")
    expect(rangeLabel("2025-12-30", "2026-01-02", NOW)).toBe("Dec 30, 2025 – Jan 2")
  })

  test("clear: no range gives two empty days and 'Any date'; a bad day is no bound", () => {
    expect(fromDayRange(undefined)).toEqual({ from: "", to: "" })
    expect(toDayRange("", "")).toBeUndefined()
    expect(rangeLabel("", "", NOW)).toBe("Any date")
    for (const bad of ["2026-02-30", "2026-13-01", "11/01/2026", "x"]) expect(parseDay(bad)).toBeUndefined()
    expect(toDayRange("2026-02-30", "")).toBeUndefined()
  })

  test("the filter itself is unchanged: the picker's days filter as the two inputs did", () => {
    const days = fromDayRange({ from: d(2026, 9, 10), to: d(2026, 9, 12) })
    const shown = filterFindings(many, { ...DEFAULT_VIEW, ...days })
    expect(shown.length).toBeGreaterThan(0)
    for (const f of shown) {
      const day = new Date(f.at as number)
      expect(day >= d(2026, 9, 10) && day < d(2026, 9, 13)).toBe(true)
    }
  })
})

describe("a stored view's days are made safe when read (review m2, m3)", () => {
  const NOW = new Date(2026, 10, 13)
  const view = (from: string, to: string) => normaliseDays({ ...DEFAULT_VIEW, from, to })

  test("m2: a 'to' before 'from' (saved by the old two inputs) is dropped: the label reads 'From …', the filter keeps rows", () => {
    const v = view("2026-09-12", "2026-09-01")
    expect([v.from, v.to]).toEqual(["2026-09-12", ""])
    expect(rangeLabel(v.from, v.to, NOW)).toBe("From Sep 12")
    // Unnormalised, the same view shows an inverted label and filters to nothing.
    expect(filterFindings(many, { ...DEFAULT_VIEW, from: "2026-09-12", to: "2026-09-01" })).toHaveLength(0)
    expect(filterFindings(many, v).length).toBeGreaterThan(0)
  })

  test("m3: a day that is not a real date is no bound, in the label and in the filter", () => {
    for (const [from, to] of [["bogus", ""], ["", "2026-02-30"], ["2026-13-01", "nope"]]) {
      const v = view(from, to)
      expect([v.from, v.to]).toEqual(["", ""])
      expect(rangeLabel(v.from, v.to, NOW)).toBe("Any date")
      expect(filterFindings(many, v)).toHaveLength(filterFindings(many, DEFAULT_VIEW).length)
    }
    // One bad end, one good end: the good one stays.
    expect([view("bogus", "2026-09-20").from, view("bogus", "2026-09-20").to]).toEqual(["", "2026-09-20"])
    // Unnormalised, a bad 'from' drops every dated row (the old filter compared the raw string).
    expect(filterFindings(many, { ...DEFAULT_VIEW, from: "bogus" })).toHaveLength(0)
  })

  test("a valid view is returned as it is", () => {
    const v = { ...DEFAULT_VIEW, from: "2026-09-01", to: "2026-09-12" }
    expect(normaliseDays(v)).toBe(v)
    expect(normaliseDays(DEFAULT_VIEW)).toBe(DEFAULT_VIEW)
  })
})

describe("still columns: every row has the same tracks, whatever its title, module or state", () => {
  const rows: FindingSummary[] = [
    { ...many[1], title: "A" },
    { ...many[2], title: "A much longer finding title that will be cut at the edge of its own column, never pushing the marks", pack: "supply-chain" },
    { ...many[3], title: "Proven high", proven: true, severity: "high" as const, pack: "web" },
    { ...many[4], title: "Dismissed", dismissed: true, pack: "domains" },
    { ...many[5], title: "No module", pack: "" },
    { ...many[6], title: "tls-cipherlist_3des_idea", severity: "low", at: null },
  ]
  const html = renderToStaticMarkup(
    <ul>
      {rows.map((f) => (
        <FindingListRow key={f.id} finding={f} moduleTitle={f.pack || "Unknown"} run={undefined} active={false} onOpen={() => {}} onCopy={() => {}} onOpenRun={() => {}} />
      ))}
    </ul>,
  )
  const lis = [...html.matchAll(/<li data-slot="finding-row"[^>]*class="([^"]*)"/g)].map((m) => m[1])

  test("every row is one grid with the same column tracks", () => {
    expect(lis).toHaveLength(rows.length)
    for (const cls of lis) expect(cls).toContain(FINDING_ROW_COLS)
    // Only the dismissed row adds a class (its muted title); the tracks are the same.
    const tracks = lis.map((c) => c.match(/grid-cols-\[[^\]]*\]/)?.[0])
    expect(new Set(tracks).size).toBe(1)
    expect(tracks[0]).toBe("grid-cols-[2rem_minmax(0,1fr)_1.25rem_1.75rem_2rem]")
  })

  test("each row has its severity and module cells in their own tracks, in the same order, even with no module", () => {
    const cells = html.split('<li data-slot="finding-row"').slice(1).map((li) => [...li.matchAll(/data-col="(\w+)"/g)].map((m) => m[1]))
    expect(cells).toEqual(rows.map(() => ["severity", "module"]))
  })

  test("the module cell is the sidebar's module dots: one dot in the module's colour, in a fixed 28 px box", () => {
    const four = ["web", "domains", "surface", "phishing"].map((pack, i) => ({ ...many[10 + i], pack }))
    const out = renderToStaticMarkup(
      <ul>
        {[...four, { ...many[14], pack: "" }].map((f) => (
          <FindingListRow key={f.id} finding={f} moduleTitle={f.pack ? `${f.pack} title` : "Unknown"} run={undefined} active={false} onOpen={() => {}} onCopy={() => {}} onOpenRun={() => {}} />
        ))}
      </ul>,
    )
    const cells = out.split('data-col="module"').slice(1).map((c) => c.slice(0, c.indexOf("</li>")))
    expect(cells).toHaveLength(5)
    four.forEach((f, i) => {
      const dots = [...cells[i].matchAll(/data-slot="module-dot" data-module="([\w-]+)"/g)].map((m) => m[1])
      expect(dots).toEqual([f.pack])
      expect(cells[i]).toContain(`aria-label="Module: ${f.pack} title"`)
      expect(cells[i]).toMatch(/data-slot="module-dots"[^>]*style="width:28px"/)
      expect(cells[i]).not.toContain('data-slot="module-pill"')
    })
    // No module: the same empty box, so the column does not move.
    expect(cells[4]).toMatch(/data-slot="module-dots" aria-hidden="true"[^>]*style="width:28px"/)
    expect(cells[4]).not.toContain("module-dot\"")
    // The dot's ring takes the row's fill: the card at rest.
    expect(out).toContain("[--module-dots-ring:var(--card)]")
  })

  test("the loading rows use the same tracks, so the list does not move when the findings arrive", () => {
    const loading = renderToStaticMarkup(<FindingsLoading />)
    const tracks = [...loading.matchAll(/data-slot="finding-row" class="([^"]*)"/g)].map((m) => m[1])
    expect(tracks.length).toBeGreaterThan(0)
    for (const cls of tracks) expect(cls).toContain(FINDING_ROW_COLS)
  })

  test("the title is the only flexible track, and it truncates", () => {
    expect(FINDING_ROW_COLS.match(/minmax\(0,1fr\)/g)).toHaveLength(1)
    expect(html).toContain('class="truncate"')
  })
})

process.on("exit", () => rmSync(dir, { recursive: true, force: true }))
