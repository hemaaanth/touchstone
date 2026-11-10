import { useEffect, useMemo, useState } from "react"
import { Check, Loader2, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react"
import type { DiscoveredModel, ModelDraft, ProviderSetting, SettingsState } from "@/lib/types"
import { deleteProvider, discoverModels, fetchSettings, saveProvider, setDefaultModel, setRunBudget } from "@/lib/api"
import { formatUsd } from "@/lib/format"
import { cn } from "@/lib/utils"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export function SettingsPage({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<SettingsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  useEffect(() => { fetchSettings().then(setSettings, (e) => setError(String(e.message))) }, [])
  const apply = (s: SettingsState) => { setSettings(s); setError(null); onChanged() }
  const attempt = async (fn: () => Promise<SettingsState>) => {
    try { apply(await fn()); return true }
    catch (e) { setError(String((e as Error).message)); return false }
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b px-5 py-3">
        <SidebarTrigger className="-ml-1 md:hidden" />
        <Settings2 className="size-4" />
        <h1 className="text-sm font-semibold">Settings</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!settings ? <p className="p-5 text-sm text-muted-foreground">{error ?? "Loading…"}</p> : (
          <div className="mx-auto max-w-3xl px-5 py-8 md:px-8 md:py-10">
            {error ? <p role="alert" className="mb-4 text-sm">{error}</p> : null}
            <section aria-labelledby="providers-title">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 id="providers-title" className="text-sm font-semibold">Providers</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Choose the provider and model for new runs.</p>
                </div>
                <Button variant="outline" size="sm" disabled={editing === "new"} onClick={() => setEditing("new")}><Plus /> Add provider</Button>
              </div>
              {settings.envOverride ? <p className="mb-3 text-xs text-muted-foreground">The server fixes the provider to {settings.envOverride}. Restart without PROVIDER to change it.</p> : null}
              <ul className="divide-y border-y">
                {settings.providers.map((p) => (
                  <li key={p.id}>
                    <ProviderRow provider={p} isDefault={settings.default.provider === p.id} defaultModel={settings.default.model}
                      locked={Boolean(settings.envOverride)} editing={editing === p.id}
                      onEdit={() => setEditing(editing === p.id ? null : p.id)}
                      onMakeDefault={(model) => attempt(() => setDefaultModel(p.id, model))} />
                    {editing === p.id ? <ProviderEditor provider={p} onSaved={(s) => { apply(s); setEditing(null) }} onCancel={() => setEditing(null)}
                      onDelete={p.saved ? async () => {
                        if (!window.confirm(p.builtIn ? `Reset ${p.label}? This removes its saved key and models.` : `Remove ${p.label}?`)) return
                        if (await attempt(() => deleteProvider(p.id))) setEditing(null)
                      } : undefined} /> : null}
                  </li>
                ))}
              </ul>
              {editing === "new" ? <ProviderEditor onSaved={(s) => { apply(s); setEditing(null) }} onCancel={() => setEditing(null)} /> : null}
            </section>
            <BudgetSection settings={settings} onSave={(n) => attempt(() => setRunBudget(n))} />
          </div>
        )}
      </div>
    </div>
  )
}

function ProviderRow({ provider: p, isDefault, defaultModel, locked, editing, onEdit, onMakeDefault }: {
  provider: ProviderSetting; isDefault: boolean; defaultModel: string | null; locked: boolean; editing: boolean
  onEdit: () => void; onMakeDefault: (model: string) => Promise<boolean>
}) {
  const [busy, setBusy] = useState(false)
  const ready = p.key.set && p.models.length > 0
  const choose = async (model: string) => { setBusy(true); await onMakeDefault(model); setBusy(false) }
  const current = p.models.find((m) => m.alias === defaultModel) ?? p.models[0]
  const items = p.models.map((m) => ({ value: m.alias, label: m.id }))
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 py-4 sm:grid-cols-[minmax(8rem,1fr)_minmax(0,1.3fr)_11rem]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{p.label}</span>
          {isDefault ? <span className="text-[11px] text-muted-foreground">Default</span> : null}
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">{p.key.set ? "Key connected" : "No API key"}{p.key.set && p.key.last4 ? ` · …${p.key.last4}` : ""}</p>
      </div>
      <div className="col-span-2 row-start-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1">
        {isDefault && items.length > 1 ? (
          <Select items={items} value={current?.alias ?? null} onValueChange={(v) => { if (v && v !== current?.alias) void choose(String(v)) }}>
            <SelectTrigger className="w-full min-w-0 bg-transparent text-xs" aria-label={`Default model for ${p.label}`} disabled={busy || !ready}>
              <SelectValue className="min-w-0 truncate" />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} align="end" className="max-w-[calc(100vw-2rem)] p-1">
              {items.map((m) => <SelectItem key={m.value} value={m.value} className="text-xs"><span className="truncate">{m.label}</span></SelectItem>)}
            </SelectContent>
          </Select>
        ) : isDefault && current ? <p className="truncate text-xs text-muted-foreground" title={current.id}>{current.id}</p>
          : <span className="text-xs text-muted-foreground">{p.models.length} {p.models.length === 1 ? "model" : "models"}</span>}
      </div>
      <div className="col-start-2 row-start-1 flex items-center justify-end gap-1 sm:col-start-3">
        {!isDefault && ready && !locked ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void choose(p.models[0].alias)}>{busy ? <Loader2 className="animate-spin" /> : null}Make default</Button> : null}
        <Button variant={editing ? "secondary" : "ghost"} size="sm" onClick={onEdit} aria-label={`${editing ? "Close" : "Edit"} ${p.label}`}>{editing ? "Close" : "Edit"}</Button>
      </div>
    </div>
  )
}

function BudgetSection({ settings, onSave }: { settings: SettingsState; onSave: (n: number) => Promise<boolean> }) {
  const saved = settings.spend.budgetUsd
  const [value, setValue] = useState(String(saved))
  const [busy, setBusy] = useState(false)
  const n = Number(value)
  const valid = Number.isFinite(n) && n >= 0.01 && n <= 1000
  return (
    <section className="mt-9" aria-labelledby="budget-title">
      <h2 id="budget-title" className="text-sm font-semibold">Run budget</h2>
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4 border-y py-4">
        <div className="min-w-48 flex-1">
          <p className="text-sm">Default per run</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Set a different amount in New run.</p>
        </div>
        <form className="flex items-center gap-2" onSubmit={async (e) => {
          e.preventDefault()
          if (!valid || n === saved || busy) return
          setBusy(true); await onSave(n); setBusy(false)
        }}>
          <label className="relative flex items-center">
            <span className="pointer-events-none absolute left-2.5 text-xs text-muted-foreground">$</span>
            <Input className="w-24 pl-6 text-xs tabular-nums" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Default budget per run in USD" aria-invalid={!valid} />
          </label>
          <Button type="submit" variant="outline" disabled={!valid || n === saved || busy}>{busy ? <Loader2 className="animate-spin" /> : "Save"}</Button>
        </form>
      </div>
      {!valid ? <p role="alert" className="mt-2 text-xs">Enter $0.01 to $1,000.</p> : null}
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Checked between model calls. The final call may exceed the budget.</p>
      <p className="mt-5 text-xs text-muted-foreground">Total spent <span className="ml-1 tabular-nums text-foreground/80">{formatUsd(settings.spend.usd)}</span></p>
    </section>
  )
}

const draftOf = (m: { id: string; input: number | null; output: number | null; context: number | null }, priced = true): ModelDraft => ({
  id: m.id,
  input: priced && m.input != null ? String(m.input) : "",
  output: priced && m.output != null ? String(m.output) : "",
  context: m.context,
})

// Add or edit one provider. "Fetch models" lists what the gateway serves for
// this key (GET /models, free). The operator ticks the models runs may use.
function ProviderEditor({
  provider,
  onSaved,
  onCancel,
  onDelete,
}: {
  provider?: ProviderSetting
  onSaved: (s: SettingsState) => void
  onCancel: () => void
  onDelete?: () => void
}) {
  const [label, setLabel] = useState(provider?.label ?? "")
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "")
  const [apiKey, setApiKey] = useState("")
  const [chosen, setChosen] = useState<ModelDraft[]>(() => (provider?.models ?? []).map((m) => draftOf(m, m.priced)))
  const [found, setFound] = useState<DiscoveredModel[] | null>(null)
  const [filter, setFilter] = useState("")
  const [manual, setManual] = useState("")
  const [busy, setBusy] = useState<"fetch" | "save" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rows = useMemo(() => {
    const ids = new Set(chosen.map((m) => m.id))
    const extra = (found ?? []).filter((m) => !ids.has(m.id))
    const q = filter.trim().toLowerCase()
    const pick = (id: string) => !q || id.toLowerCase().includes(q)
    return [...chosen.filter((m) => pick(m.id)).map((m) => ({ id: m.id, on: true })), ...extra.filter((m) => pick(m.id)).map((m) => ({ id: m.id, on: false }))]
  }, [chosen, found, filter])

  const toggle = (id: string) => {
    if (chosen.some((m) => m.id === id)) {
      setChosen(chosen.filter((m) => m.id !== id))
      return
    }
    const f = found?.find((m) => m.id === id)
    setChosen([...chosen, f ? draftOf(f) : { id, input: "", output: "", context: null }])
  }
  const setPrice = (id: string, field: "input" | "output", value: string) =>
    setChosen(chosen.map((m) => (m.id === id ? { ...m, [field]: value } : m)))

  const fetchList = async () => {
    setBusy("fetch")
    setError(null)
    try {
      const r = await discoverModels({ id: provider?.id, baseUrl, apiKey: apiKey || undefined })
      setFound(r.models)
      // Refresh prices the gateway publishes for models already chosen.
      setChosen((cur) =>
        cur.map((m) => {
          const f = r.models.find((x) => x.id === m.id)
          return f && f.input != null && f.output != null && !m.input && !m.output ? draftOf(f) : m
        }),
      )
      if (r.models.length === 0) setError("The gateway listed no models. Add model ids by hand below.")
    } catch (e) {
      setError(String((e as Error).message))
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    setBusy("save")
    setError(null)
    try {
      onSaved(await saveProvider({ id: provider?.id, label, baseUrl, apiKey: apiKey || undefined, models: chosen }))
    } catch (e) {
      setError(String((e as Error).message))
    } finally {
      setBusy(null)
    }
  }

  const keyHint = provider?.key.set
    ? provider.key.source === "env"
      ? "Leave blank to keep the connected key"
      : `Leave blank to keep …${provider.key.last4 ?? "····"}`
    : "Paste the API key"

  return (
    <div className="flex flex-col gap-4 border-t border-border/50 bg-background/40 px-4 py-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Name</span>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Lyber" disabled={Boolean(provider)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Base URL</span>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} autoCapitalize="off" />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">API key</span>
        <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={keyHint} autoComplete="off" spellCheck={false} />
      </label>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Models · {chosen.length} on</span>
          <Button variant="ghost" size="sm" className="ml-auto" disabled={!baseUrl || busy !== null} onClick={fetchList}>
            {busy === "fetch" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Fetch models
          </Button>
        </div>
        {(found?.length ?? 0) > 8 ? <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter, e.g. abliterated" /> : null}
        {rows.length > 0 ? (
          <ul className="max-h-80 overflow-y-auto rounded-lg bg-muted/40 py-1">
            {rows.map(({ id, on }) => {
              const d = chosen.find((m) => m.id === id)
              return (
                <li key={id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-1">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggle(id)}
                    className="flex min-w-0 flex-1 basis-full items-center gap-2 rounded-md py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:basis-0"
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-[5px] transition-colors",
                        on ? "bg-foreground text-background" : "bg-foreground/10",
                      )}
                    >
                      {on ? <Check className="size-3" strokeWidth={3} /> : null}
                    </span>
                    <span className={cn("truncate font-mono text-xs", !on && "text-muted-foreground")}>{id}</span>
                  </button>
                  {d ? (
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      in $
                      <input className="h-6 w-14 rounded-md bg-background/60 px-1.5 text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/50" inputMode="decimal" value={d.input} placeholder="?" onChange={(e) => setPrice(id, "input", e.target.value)} aria-label={`${id} input price per 1M`} />
                      out $
                      <input className="h-6 w-14 rounded-md bg-background/60 px-1.5 text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/50" inputMode="decimal" value={d.output} placeholder="?" onChange={(e) => setPrice(id, "output", e.target.value)} aria-label={`${id} output price per 1M`} />
                      /1M
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No models yet. Fetch them, or add an id by hand.</p>
        )}
        <div className="flex gap-2">
          <Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Add a model id by hand" className="font-mono" spellCheck={false} autoCapitalize="off" />
          <Button
            variant="ghost"
            disabled={!manual.trim() || chosen.some((m) => m.id === manual.trim())}
            onClick={() => {
              setChosen([...chosen, { id: manual.trim(), input: "", output: "", context: null }])
              setManual("")
            }}
          >
            Add
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">Prices are USD per 1M tokens. A model with no price is charged a high fallback price.</p>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button disabled={!label.trim() || !baseUrl.trim() || chosen.length === 0 || busy !== null} onClick={save}>
          {busy === "save" ? <Loader2 className="animate-spin" /> : <Check />} Save
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {onDelete ? (
          <Button variant="ghost" className="ml-auto text-muted-foreground hover:text-destructive" onClick={onDelete}>
            <Trash2 /> {provider?.builtIn ? "Reset" : "Remove"}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
