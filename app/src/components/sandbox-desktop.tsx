import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { SandboxDesktopView } from "@/lib/types"
import { closeRunDesktop, openRunDesktop } from "@/lib/api"
import { Button } from "@/components/ui/button"

// Capability URLs live only in component memory. Never use browser storage.
export function SandboxDesktop({ runId, agent, live, closedAt }: { runId: string; agent: string; live: boolean; closedAt: number }) {
  const [view, setView] = useState<SandboxDesktopView>({ kind: "closed" })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const mounted = useRef(false)
  const owned = useRef(false)
  const sending = useRef(false)
  const current = useRef({ closedAt, live })
  const [seen, setSeen] = useState({ closedAt, live })
  if (seen.closedAt !== closedAt || seen.live !== live) {
    setSeen({ closedAt, live })
    setView({ kind: "closed" })
  }
  useLayoutEffect(() => {
    if (current.current.closedAt !== closedAt || !live) generation.current++
    current.current = { closedAt, live }
  }, [closedAt, live])
  const changed = useCallback(async (mode: "watch" | "control" | "close") => {
    if (sending.current || !current.current.live) return
    const gen = ++generation.current
    const version = current.current.closedAt
    sending.current = true
    owned.current = true
    setBusy(true)
    setError(null)
    // Remove the old iframe before any mode change or revocation.
    setView({ kind: "closed" })
    try {
      const next = mode === "close" ? await closeRunDesktop(runId, agent) : await openRunDesktop(runId, agent, mode === "watch")
      if (mounted.current && gen === generation.current && current.current.live && version === current.current.closedAt) {
        setView(next)
        owned.current = next.kind === "open"
      } else if (next.kind === "open") {
        await closeRunDesktop(runId, agent)
        owned.current = false
      }
    } catch (cause) { if (mounted.current && gen === generation.current) setError(cause instanceof Error ? cause.message : "Desktop request failed.") }
    finally {
      sending.current = false
      if (mounted.current) setBusy(false)
    }
  }, [runId, agent])
  const invalidate = useCallback(() => {
    mounted.current = false
    generation.current++
    if (owned.current) void closeRunDesktop(runId, agent).catch(() => {})
  }, [runId, agent])
  useEffect(() => {
    mounted.current = true
    return invalidate
  }, [invalidate])
  const opened = live && view.kind === "open" ? view : null
  useEffect(() => {
    if (view.kind !== "open") return
    const timer = setTimeout(() => { void changed("close") }, Math.max(0, view.expires - Date.now()))
    return () => clearTimeout(timer)
  }, [view, changed]) // The server also expires and revokes setup and open leases.
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
        <iframe key={opened.url} title={`Sandbox desktop: ${agent}`} src={opened.url} sandbox="allow-scripts allow-same-origin allow-pointer-lock" referrerPolicy="no-referrer" allow={opened.viewOnly ? "autoplay; fullscreen" : "autoplay; fullscreen; clipboard-read"} className="aspect-video min-h-48 w-full bg-muted" />
      </> : null}
    </section>
  )
}
