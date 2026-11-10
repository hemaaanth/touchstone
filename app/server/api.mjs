// Framework-agnostic API router. Given a request URL it returns a plain
// { status, json } result, so the same logic works behind Vite's dev
// middleware now and a standalone http server later (when runs go live).
import { listFindings, getFinding } from "./findings.mjs"

export async function handleApi(url) {
  const { pathname } = new URL(url, "http://local")
  if (pathname === "/api/findings") {
    return { status: 200, json: { findings: await listFindings() } }
  }
  const match = pathname.match(/^\/api\/findings\/([^/]+)$/)
  if (match) {
    const finding = await getFinding(decodeURIComponent(match[1]))
    return finding
      ? { status: 200, json: finding }
      : { status: 404, json: { error: "not found" } }
  }
  return { status: 404, json: { error: "unknown route" } }
}
