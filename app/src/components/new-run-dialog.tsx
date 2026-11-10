import { useEffect, useState } from "react"
import { Loader2, Play } from "lucide-react"
import type { ModelChoice, SpendState, TargetChoice } from "@/lib/types"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"

// The New Run dialog. It picks the model (an abliterated one by default) and a
// scope, then calls onStart — the same startRun path the old launcher used, so
// no backend change. Leaving the scope on "Random" omits targetId, which lets
// the server pick, so repeated runs stop re-breaking one bug.
export function NewRunDialog({
  open,
  onOpenChange,
  models,
  targets,
  spend,
  busy,
  error,
  onStart,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  models: ModelChoice[]
  targets: TargetChoice[]
  spend: SpendState | null
  busy: boolean
  error: string | null
  onStart: (alias: string, targetId?: string) => void
}) {
  const runnable = targets.filter((t) => t.runnable)
  const [alias, setAlias] = useState("")
  const [scopeId, setScopeId] = useState("random")

  // Default the model to the first abliterated one as soon as models load.
  useEffect(() => {
    if (alias || models.length === 0) return
    setAlias((models.find((m) => m.abliterated) ?? models[0]).alias)
  }, [models, alias])

  const capped = spend ? spend.usd >= spend.cap : false
  const canStart = alias !== "" && runnable.length > 0 && !busy && !capped
  const scope = runnable.find((t) => t.id === scopeId) ?? null

  const submit = () => {
    if (!canStart) return
    onStart(alias, scopeId === "random" ? undefined : scopeId)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New run</DialogTitle>
          <DialogDescription>
            An abliterated model attacks the scope inside a sandbox. Nothing is real until a Foundry
            replay proves it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <Field label="Model">
            <Select value={alias} onValueChange={(v) => setAlias(v ?? "")}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a model" />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.alias} value={m.alias}>
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs">{m.alias}</span>
                      {m.abliterated ? (
                        <Badge variant="secondary" className="text-[10px]">
                          abliterated
                        </Badge>
                      ) : null}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Scope">
            <Select value={scopeId} onValueChange={(v) => setScopeId(v ?? "random")}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a scope" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="random">Random from library</SelectItem>
                {runnable.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {scope ? <p className="text-xs text-muted-foreground">{scope.blurb}</p> : null}
          </Field>

          {capped ? (
            <p className="text-xs text-destructive">Spend cap reached. Raise the cap to start a run.</p>
          ) : runnable.length === 0 ? (
            <p className="text-xs text-destructive">No runnable scopes are available right now.</p>
          ) : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canStart} className="gap-2">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            Start run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}
