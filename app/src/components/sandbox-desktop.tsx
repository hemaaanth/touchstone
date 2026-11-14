import { useCallback, useEffect, useRef, useState } from "react"
import type { SandboxDesktopView } from "@/lib/types"
import { closeRunDesktop, openRunDesktop } from "@/lib/api"
import { Button } from "@/components/ui/button"

// Capability URLs live only in component memory. Never use browser storage.
export function SandboxDesktop({ runId, agent, live, closedAt }: { runId: string; agent: string; live: boolean; closedAt: number }) {
  const [view, setView] = useState<SandboxDesktopView>({ kind: "closed" })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const invalidate = useCallback(() => { generation.current++ }, [])
  const [seen, setSeen] = useState({ closedAt, live })
  if (seen.closedAt !== closedAt || seen.live !== live) {
    setSeen({ closedAt, live })
    setView({ kind: "closed" })
  }
  const changed = useCallback(async (mode: "watch" | "control" | "close") => {
    const gen = ++generation.current
    setBusy(true)
    setError(null)
    // Remove the old iframe before any mode change or revocation.
    setView({ kind: "closed" })
    try {
      const next = mode === "close" ? await closeRunDesktop(runId, agent) : await openRunDesktop(runId, agent, mode === "watch")
      if (gen === generation.current && live) setView(next)
    } catch (cause) { if (gen === generation.current) setError(cause instanceof Error ? cause.message : "Desktop request failed.") }
    finally { if (gen === generation.current) setBusy(false) }
  }, [runId, agent, live])
  useEffect(() => {
    return () => {
      invalidate()
      void closeRunDesktop(runId, agent).catch(() => {})
    }
  }, [runId, agent, invalidate])
  const opened = live && view.kind === "open" ? view : null
  useEffect(() => {
    if (view.kind !== "open") return
    const timer = setTimeout(() => { void changed("close") }, Math.max(0, view.expires - Date.now()))
    return () => clearTimeout(timer)
  }, [view, changed]) // The server also expires and revokes the lease.
  return (
    <section aria-label={`Desktop for ${agent}`} className="flex flex-col gap-2 bg-muted/20 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Sandbox desktop</span>
        <span className="text-muted-foreground">{opened ? opened.viewOnly ? "Watching" : "You have control" : "Closed"}</span>
        {opened ? <span className="text-muted-foreground">until {new Date(opened.expires).toLocaleTimeString()}</span> : null}
        <div className="ml-auto flex gap-1">
          {!opened ? <Button size="sm" variant="ghost" disabled={!live || busy} onClick={() => void changed("watch")}>Watch</Button> : null}
          {opened?.viewOnly ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void changed("control")}>Take control</Button> : null}
          {opened || error ? <Button size="sm" variant="ghost" disabled={!live || busy} onClick={() => void changed("close")}>Release</Button> : null}
        </div>
      </div>
      {busy ? <p role="status">Waiting for the runtime…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {opened ? <>
        <p className="text-muted-foreground">Keep passwords and codes in the browser, not in chat. Take control pauses managed shell and browser automation. Other sandbox processes may observe your input.</p>
        <iframe key={opened.url} title={`Sandbox desktop: ${agent}`} src={opened.url} sandbox="allow-scripts allow-same-origin allow-pointer-lock" referrerPolicy="no-referrer" allow="autoplay; fullscreen" className="aspect-video min-h-48 w-full bg-muted" />
      </> : null}
    </section>
  )
}
