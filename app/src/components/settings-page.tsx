import { useEffect, useMemo, useState } from "react"
import { Check, Loader2, Pencil, Plus, RefreshCw, Settings2, Star, Trash2, X } from "lucide-react"
import type { DiscoveredModel, ModelDraft, ProviderSetting, SettingsState } from "@/lib/types"
import { deleteProvider, discoverModels, fetchSettings, saveProvider, setDefaultModel, setRunBudget } from "@/lib/api"
import { cn } from "@/lib/utils"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { ProviderLogo } from "@/components/provider-logo"
import { Input } from "@/components/ui/input"

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
          <div className="mx-auto max-w-2xl px-5 py-8 md:px-8 md:py-10">
            {error ? <p role="alert" className="mb-4 text-sm">{error}</p> : null}
            <section aria-labelledby="providers-title">
              <div className="mb-2 flex items-center justify-between gap-3 px-2">
                <h2 id="providers-title" className="text-sm font-semibold">Providers</h2>
                <Button variant="ghost" size="sm" className="-mr-2 text-muted-foreground hover:text-foreground" disabled={editing === "new"} onClick={() => setEditing("new")}>
                  <Plus /> Add
                </Button>
              </div>
              {settings.envOverride ? <p className="mb-2 px-2 text-xs text-muted-foreground">The server fixes the provider to {settings.envOverride}. Restart without PROVIDER to change it.</p> : null}
              <ul className="flex flex-col gap-0.5">
                {settings.providers.map((p) => {
                  const isDefault = settings.default.provider === p.id
                  const makeDefault = p.key.set && !settings.envOverride
                    ? (alias: string) => attempt(() => setDefaultModel(p.id, alias))
                    : null
                  return (
                    <li key={p.id}>
                      <ProviderRow
                        provider={p}
                        isDefault={isDefault}
                        editing={editing === p.id}
                        onEdit={() => setEditing(editing === p.id ? null : p.id)}
                        onMakeDefault={makeDefault}
                      />
                      {editing === p.id ? (
                        <ProviderEditor
                          provider={p}
                          defaultAlias={isDefault ? settings.default.model : null}
                          onMakeDefault={makeDefault}
                          onSaved={(s) => { apply(s); setEditing(null) }}
                          onCancel={() => setEditing(null)}
                          onDelete={p.saved ? async () => {
                            if (!window.confirm(p.builtIn ? `Reset ${p.label}? This removes its saved key and models.` : `Remove ${p.label}?`)) return
                            if (await attempt(() => deleteProvider(p.id))) setEditing(null)
                          } : undefined}
                        />
                      ) : null}
                    </li>
                  )
                })}
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

// The star that marks the default. Every row has one in the same place. The
// default's star is filled; any other star makes its row the default. A star
// that cannot be used (no key, no models, or the server fixes the provider)
// stays dim.
function DefaultStar({ on, label, onPick }: { on: boolean; label: string; onPick: (() => Promise<boolean>) | null }) {
  const [busy, setBusy] = useState(false)
  if (on) {
    return (
      <span role="img" aria-label={`${label} is the default`} title="Default" className="flex size-7 items-center justify-center">
        <Star className="size-4 fill-current text-foreground" />
      </span>
    )
  }
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground/60 hover:text-foreground"
      disabled={!onPick || busy}
      onClick={async () => {
        if (!onPick) return
        setBusy(true)
        await onPick()
        setBusy(false)
      }}
      aria-label={`Make ${label} the default`}
      title={onPick ? "Make default" : undefined}
    >
      {busy ? <Loader2 className="animate-spin" /> : <Star />}
    </Button>
  )
}

// One provider: mark, name, the default star, and edit. A provider without a key
// says so; that is the only text besides its name.
function ProviderRow({ provider: p, isDefault, editing, onEdit, onMakeDefault }: {
  provider: ProviderSetting
  isDefault: boolean
  editing: boolean
  onEdit: () => void
  onMakeDefault: ((alias: string) => Promise<boolean>) | null
}) {
  const first = p.models[0]?.alias
  const pick = onMakeDefault && first ? () => onMakeDefault(first) : null
  return (
    <div className={cn("flex items-center gap-3 rounded-lg py-1.5 pr-1 pl-2 transition-colors hover:bg-muted/50", editing && "bg-muted/50")}>
      <ProviderLogo id={p.id} label={p.label} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={keyNote(p)}>
        {p.label}
        {p.key.set ? null : <span className="ml-2 text-xs font-normal text-muted-foreground">No key</span>}
      </span>
      <DefaultStar on={isDefault} label={p.label} onPick={pick} />
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground/60 hover:text-foreground"
        onClick={onEdit}
        aria-label={`${editing ? "Close" : "Edit"} ${p.label}`}
        aria-expanded={editing}
        title={editing ? "Close" : "Edit"}
      >
        {editing ? <X /> : <Pencil />}
      </Button>
    </div>
  )
}

// Where the key comes from, for the name's tooltip. The key itself never
// reaches the browser.
function keyNote(p: ProviderSetting): string {
  if (!p.key.set) return "No API key"
  if (p.key.source === "env") return `Key from ${p.key.envName ?? "the server environment"}`
  return p.key.last4 ? `Key saved in Settings, ends ${p.key.last4}` : "Key saved in Settings"
}

function BudgetSection({ settings, onSave }: { settings: SettingsState; onSave: (n: number) => Promise<boolean> }) {
  const saved = settings.spend.budgetUsd
  const [value, setValue] = useState(String(saved))
  const [busy, setBusy] = useState(false)
  const n = Number(value)
  const valid = Number.isFinite(n) && n >= 0.01 && n <= 1000
  return (
    <section className="mt-10" aria-labelledby="budget-title">
      <h2 id="budget-title" className="mb-2 px-2 text-sm font-semibold">Run budget</h2>
      <form
        className="flex items-center justify-between gap-4 py-1.5 pr-1 pl-2"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!valid || n === saved || busy) return
          setBusy(true); await onSave(n); setBusy(false)
        }}
      >
        <label htmlFor="run-budget" className="text-sm">Default per run</label>
        <div className="flex items-center gap-2">
          <span className="relative flex items-center">
            <span className="pointer-events-none absolute left-2.5 text-xs text-muted-foreground">$</span>
            <Input id="run-budget" className="w-24 pl-6 text-xs tabular-nums" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={!valid} />
          </span>
          {valid && n !== saved ? (
            <Button type="submit" variant="outline" size="sm" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : "Save"}</Button>
          ) : null}
        </div>
      </form>
      {!valid ? <p role="alert" className="mt-1 px-2 text-xs">Enter $0.01 to $1,000.</p> : null}
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
  defaultAlias = null,
  onMakeDefault = null,
  onSaved,
  onCancel,
  onDelete,
}: {
  provider?: ProviderSetting
  // The default model's alias when this provider is the default.
  defaultAlias?: string | null
  // Makes one of this provider's saved models the default. Null when the
  // provider has no key or the server fixes the provider.
  onMakeDefault?: ((alias: string) => Promise<boolean>) | null
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
    <div className="mt-1 mb-3 flex flex-col gap-4 rounded-lg bg-muted/30 px-3 py-4 sm:pl-12">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Name</span>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My gateway" disabled={Boolean(provider)} />
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
              // A saved model can be the default; a model ticked in this edit
              // cannot until it is saved.
              const alias = provider?.models.find((m) => m.id === id)?.alias
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
                  {on && alias ? (
                    <DefaultStar
                      on={alias === defaultAlias}
                      label={id}
                      onPick={onMakeDefault ? () => onMakeDefault(alias) : null}
                    />
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
