import { useCallback, useState } from "react"
import { ArrowRight, KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { startRun, saveProvider, setDefaultModel } from "@/lib/api"

// The first five minutes of a fresh install.
//
// One thing at a time, in the centre of the stage: save a key, then run the
// simplest scope there is. Everything else — modules, budgets, Daytona, adding
// your own scope — is discoverable once one run has worked.
//
// The provider is the built-in NEAR AI Cloud preset: its base URL, models and
// prices are already known, so the only thing the operator supplies is the key.
// Saving no model list keeps the preset aliases, which is what the demo run uses.
const NEAR = { id: "near", label: "NEAR AI Cloud", baseUrl: "https://cloud-api.near.ai/v1" }
const ALIAS = "ds-abl"
const DEMO_SCOPE = "vault-reentrancy"
const DEMO_BUDGET = 0.5

export function SetupStart({
  onSaved,
  onStarted,
}: {
  // The key is stored. The caller refreshes models so the app leaves this screen.
  onSaved: () => void
  // A run exists. The caller opens it.
  onStarted: (id: string) => void
}) {
  const [key, setKey] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [running, setRunning] = useState(false)

  const save = useCallback(async () => {
    const apiKey = key.trim()
    if (!apiKey) return setError("Paste your key first.")
    setSaving(true)
    setError(null)
    try {
      await saveProvider({ ...NEAR, apiKey })
      await setDefaultModel("near", ALIAS)
      setReady(true)
      onSaved()
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setSaving(false)
    }
  }, [key, onSaved])

  const run = useCallback(async () => {
    setRunning(true)
    setError(null)
    try {
      const view = await startRun(ALIAS, DEMO_SCOPE, DEMO_BUDGET, [], "solo")
      onStarted(view.id)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
      setRunning(false)
    }
  }, [onStarted])

  return (
    <div className="grid flex-1 place-items-center p-8">
      <section className="flex w-full max-w-md flex-col gap-6" aria-labelledby="start-here">
        <div className="space-y-2">
          <h1 id="start-here" className="text-xl font-medium tracking-tight">
            Start with a key, then one run.
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Touchstone attacks with a model you bring. Both steps stay on this machine; the only traffic is to the provider you pick.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className={stepDot(ready)}>1</span>
            <KeyRound className="size-4 text-muted-foreground" />
            Add a NEAR AI Cloud key
          </div>
          {ready ? (
            <p className="pl-7 text-sm text-muted-foreground">Key saved. NEAR AI Cloud is the default provider.</p>
          ) : (
            <>
              <div className="flex gap-2 pl-7">
                <Input
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") save()
                  }}
                  placeholder="Paste your NEAR AI key"
                  aria-label="NEAR AI Cloud API key"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button onClick={save} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
              <p className="pl-7 text-xs text-muted-foreground">
                Get a key at{" "}
                <a className="focus-ring rounded-sm underline underline-offset-4 hover:text-foreground" href="https://cloud.near.ai" target="_blank" rel="noopener noreferrer">
                  cloud.near.ai
                </a>
                . Models, budget and other providers are in Settings afterwards.
              </p>
            </>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className={stepDot(ready && !running)}>2</span>
            Run the Vault demo
          </div>
          <p className="pl-7 text-sm text-muted-foreground">
            One contract with a real reentrancy. The agent reads it, writes an exploit and proves it in a throwaway workspace. About 50 ¢.
          </p>
          <div className="pl-7">
            <Button onClick={run} disabled={!ready || running}>
              {running ? "Starting…" : "Run the demo"}
              {!running ? <ArrowRight /> : null}
            </Button>
          </div>
        </div>

        {error ? <p className="text-sm text-negative">{error}</p> : null}
      </section>
    </div>
  )
}

// A small numbered mark: outlined while pending, filled once done.
const stepDot = (done: boolean) =>
  done
    ? "flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground"
    : "flex size-5 items-center justify-center rounded-full border text-[11px] font-semibold text-muted-foreground"
