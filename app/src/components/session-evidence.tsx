import { useState } from "react"
import type { Candidate } from "@/lib/candidate"
import type { SessionArtifact, SessionManifest } from "@/lib/types"
import { downloadSessionArtifact, fetchSessionArtifacts, releaseSessionScreenshot } from "@/lib/api"
import { Button } from "@/components/ui/button"

export function SessionEvidence({ runId, candidate }: { runId?: string; candidate: Candidate }) {
  const [manifest, setManifest] = useState<SessionManifest | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [release, setRelease] = useState<string | null>(null)
  const evidence = candidate.evidence
  if (!evidence || typeof evidence !== "object" || !("kind" in evidence) || evidence.kind !== "session") return null
  const hasArtifacts = "artifacts" in evidence && evidence.artifacts != null
  const perform = async (action: "list" | "read" | "release", file?: SessionArtifact) => {
    if (!runId) return
    setBusy(true)
    setError(null)
    try {
      if (action === "release" && file) {
        await releaseSessionScreenshot(runId, candidate.poc, file.id, file.sha256)
        setRelease(null)
      }
      if (action === "read" && file) {
        const blob = await downloadSessionArtifact(runId, candidate.poc, file.id)
        const url = URL.createObjectURL(blob)
        const link = document.createElement("a")
        link.href = url
        link.download = `${file.id}.${file.kind === "screenshot" ? "png" : file.kind === "har" ? "json" : "txt"}`
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      } else setManifest(await fetchSessionArtifacts(runId, candidate.poc))
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Session artifacts are unavailable.") }
    finally { setBusy(false) }
  }
  return <section aria-label="Session evidence" className="flex flex-col gap-2 bg-muted/30 p-2">
    <h3 className="font-medium">Session · unproven</h3>
    <p className="text-muted-foreground">Agent-reported shell and browser activity, not replay proof. Requests seen by the log exclude traffic that bypassed the proxy. Secret masking is not complete.</p>
    {hasArtifacts && runId ? <Button size="sm" variant="ghost" className="w-fit" disabled={busy} onClick={() => void perform("list")}>{manifest ? "Refresh session files" : "Show session files"}</Button> : <p className="text-muted-foreground">No downloadable session files were attached.</p>}
    {manifest?.files.map((file) => <div key={file.id} className="flex flex-col gap-1 py-1">
      <div className="flex flex-wrap items-center gap-2">
        <span>{file.kind} · {file.bytes.toLocaleString()} bytes</span>
        <span className="font-data break-all text-muted-foreground" title={file.sha256}>{file.sha256.slice(0, 12)}</span>
        {file.approval === "pending" ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRelease(file.id)}>Review release</Button> : <Button size="sm" variant="ghost" disabled={busy} onClick={() => void perform("read", file)}>Download {file.kind}</Button>}
      </div>
      {release === file.id && file.approval === "pending" ? <div className="flex flex-col gap-2">
        <p>Pixels cannot be scrubbed as text. Inspect this screenshot on the remote desktop first. Release only if it contains no passwords, codes, or private data. This releases only this exact image hash.</p>
        <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void perform("release", file)}>Release this screenshot</Button><Button size="sm" variant="ghost" onClick={() => setRelease(null)}>Cancel</Button></div>
      </div> : null}
    </div>)}
    {busy ? <p role="status">Reading private session files…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>
}
