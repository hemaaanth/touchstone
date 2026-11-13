// Framework-agnostic API router. Given a request URL it returns a plain
// { status, json } result, so the same logic works behind Vite's dev
// middleware now and a standalone http server later (when runs go live).
import { listCandidates, listFindings, getFinding } from "./findings.mjs"
import { scopeStoreError } from "../../spike/lib/scopes-store.mjs"
import { grantStoreError } from "../../spike/lib/grant-store.mjs"

export async function handleApi(url) {
  const { pathname, searchParams } = new URL(url, "http://local")
  // A store file that exists but cannot be read lists as empty everywhere, and
  // every write to it is refused. This says so, so the app can show it.
  if (pathname === "/api/stores") {
    return { status: 200, json: { errors: [scopeStoreError(), grantStoreError()].filter(Boolean) } }
  }
  if (pathname === "/api/findings") {
    // Candidates sit beside the findings, never among them (N3): the page lists
    // them under their own state, neutral, and they have no report.
    return { status: 200, json: { findings: await listFindings(), candidates: await listCandidates() } }
  }
  const match = pathname.match(/^\/api\/findings\/([^/]+)$/)
  if (match) {
    // ?events=0: the finding without its run's transcript (findings.mjs).
    const finding = await getFinding(decodeURIComponent(match[1]), { events: searchParams.get("events") !== "0" })
    return finding
      ? { status: 200, json: finding }
      : { status: 404, json: { error: "not found" } }
  }
  return { status: 404, json: { error: "unknown route" } }
}
