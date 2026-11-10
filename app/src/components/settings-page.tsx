import { useEffect, useMemo, useState } from "react"
import { Check, KeyRound, Loader2, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react"
import type { DiscoveredModel, ModelDraft, ProviderSetting, SettingsState } from "@/lib/types"
import { deleteProvider, discoverModels, fetchSettings, saveProvider, setDefaultModel, setSpendCap } from "@/lib/api"
import { formatUsd } from "@/lib/format"
import { cn } from "@/lib/utils"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const SELECT =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30"

// The Settings page. For now it holds the inference providers, the default
// provider and model for new runs, and the spend cap. Every provider speaks the
// OpenAI Chat Completions format: a base URL, a key, and a list of models.
// A key goes to the server once and never comes back; the page shows only its
// last 4 characters.
export function SettingsPage({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<SettingsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null) // provider id, "new", or null

  useEffect(() => {
    fetchSettings().then(setSettings, (e) => setError(String(e?.message ?? e)))
  }, [])

  const apply = (s: SettingsState) => {
    setSettings(s)
    setError(null)
    onChanged()
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b px-5 py-3">
        <SidebarTrigger className="-ml-1 md:hidden" />
        <Settings2 className="size-4" />
        <h1 className="text-sm font-semibold">Settings</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!settings ? (
          <p className="p-5 text-sm text-muted-foreground">{error ?? "Loading…"}</p>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col divide-y">
            {error ? <p className="px-5 py-3 text-sm text-destructive md:px-8">{error}</p> : null}
            <DefaultSection settings={settings} onSaved={apply} onError={setError} />
            <SpendSection settings={settings} onSaved={apply} onError={setError} />
            <section className="px-5 py-5 md:px-8">
              <SectionHead
                title="Providers"
                blurb="Any OpenAI-compatible API: a base URL that serves /chat/completions and /models, and a key. Prices are USD per 1M tokens."
              />
              <ul className="mt-3 divide-y border-y">
                {settings.providers.map((p) => (
                  <li key={p.id}>
                    <ProviderRow
                      provider={p}
                      isDefault={settings.default.provider === p.id}
                      editing={editing === p.id}
                      onEdit={() => setEditing(editing === p.id ? null : p.id)}
                      onDelete={async () => {
                        const what = p.builtIn ? `Reset ${p.label} to its built-in setup? The saved key is removed.` : `Remove ${p.label}?`
                        if (!window.confirm(what)) return
                        try {
                          apply(await deleteProvider(p.id))
                          setEditing(null)
                        } catch (e) {
                          setError(String((e as Error).message))
                        }
                      }}
                    />
                    {editing === p.id ? (
                      <ProviderEditor
                        provider={p}
                        onSaved={(s) => {
                          apply(s)
                          setEditing(null)
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
              {editing === "new" ? (
                <div className="border-b">
                  <ProviderEditor
                    onSaved={(s) => {
                      apply(s)
                      setEditing(null)
                    }}
                    onCancel={() => setEditing(null)}
                  />
                </div>
              ) : (
                <Button variant="outline" size="sm" className="mt-3" onClick={() => setEditing("new")}>
                  <Plus /> Add provider
                </Button>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

function SectionHead({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-xs text-muted-foreground">{blurb}</p>
    </div>
  )
}

function keyLabel(p: ProviderSetting): string {
  if (!p.key.set) return "No key"
  if (p.key.source === "env") return `Key from ${p.key.envName ?? "env"}`
  return p.key.last4 ? `Key …${p.key.last4}` : "Key saved"
}

// ---- Default provider and model for new runs.
function DefaultSection({
  settings,
  onSaved,
  onError,
}: {
  settings: SettingsState
  onSaved: (s: SettingsState) => void
  onError: (e: string) => void
}) {
  const ready = settings.providers.filter((p) => p.key.set && p.models.length > 0)
  const [providerId, setProviderId] = useState(settings.default.provider)
  const provider = settings.providers.find((p) => p.id === providerId)
  const [model, setModel] = useState(settings.default.model ?? "")
  const modelOk = provider?.models.some((m) => m.alias === model)
  const chosenModel = modelOk ? model : provider?.models[0]?.alias ?? ""
  const current = settings.providers.find((p) => p.id === settings.default.provider)
  const currentModel = current?.models.find((m) => m.alias === settings.default.model)
  const dirty = providerId !== settings.default.provider || chosenModel !== settings.default.model
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      onSaved(await setDefaultModel(providerId, chosenModel))
    } catch (e) {
      onError(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="px-5 py-5 md:px-8">
      <SectionHead title="Default for new runs" blurb="Every new run uses this provider and model. A run keeps its provider for follow-ups." />
      <p className="mt-3 text-sm">
        Now: <span className="font-medium">{current?.label ?? settings.default.provider}</span>
        {currentModel ? <span className="font-mono text-xs text-muted-foreground"> · {currentModel.id}</span> : null}
      </p>
      {settings.envOverride ? (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
          The server was started with PROVIDER={settings.envOverride}. That overrides the choice here until it restarts without it.
        </p>
      ) : null}
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1.5fr_auto]">
        <select className={SELECT} value={providerId} onChange={(e) => setProviderId(e.target.value)} aria-label="Provider">
          {settings.providers.map((p) => (
            <option key={p.id} value={p.id} disabled={!ready.includes(p)}>
              {p.label}
              {ready.includes(p) ? "" : p.key.set ? " (no models)" : " (no key)"}
            </option>
          ))}
        </select>
        <select className={SELECT} value={chosenModel} onChange={(e) => setModel(e.target.value)} aria-label="Model">
          {provider?.models.map((m) => (
            <option key={m.alias} value={m.alias}>
              {m.id}
            </option>
          ))}
        </select>
        <Button size="default" disabled={!dirty || busy || !provider?.key.set || !chosenModel} onClick={save}>
          {busy ? <Loader2 className="animate-spin" /> : <Check />} Use
        </Button>
      </div>
    </section>
  )
}

// ---- Spend cap.
function SpendSection({
  settings,
  onSaved,
  onError,
}: {
  settings: SettingsState
  onSaved: (s: SettingsState) => void
  onError: (e: string) => void
}) {
  const [cap, setCap] = useState(String(settings.spend.cap))
  const dirty = Number(cap) !== settings.spend.cap
  const left = Math.max(0, settings.spend.cap - settings.spend.usd)
  return (
    <section className="px-5 py-5 md:px-8">
      <SectionHead title="Spend cap" blurb="One cap across all providers. A run will not start once spend reaches it." />
      <p className="mt-3 text-sm">
        {formatUsd(settings.spend.usd)} spent of {formatUsd(settings.spend.cap)}. {formatUsd(left)} left.
      </p>
      <div className="mt-3 flex max-w-xs items-center gap-2">
        <span className="text-sm text-muted-foreground">$</span>
        <Input type="number" min="1" step="1" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} aria-label="Spend cap in USD" />
        <Button
          variant="outline"
          disabled={!dirty || !(Number(cap) > 0)}
          onClick={async () => {
            try {
              onSaved(await setSpendCap(Number(cap)))
            } catch (e) {
              onError(String((e as Error).message))
            }
          }}
        >
          Save
        </Button>
      </div>
    </section>
  )
}

function ProviderRow({
  provider: p,
  isDefault,
  editing,
  onEdit,
  onDelete,
}: {
  provider: ProviderSetting
  isDefault: boolean
  editing: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="flex items-start gap-3 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium">{p.label}</span>
          {isDefault ? <span className="text-[11px] font-medium text-primary">Default</span> : null}
          {p.builtIn ? <span className="text-[11px] text-muted-foreground">Built in</span> : null}
        </div>
        <span className="truncate font-mono text-xs text-muted-foreground">{p.baseUrl}</span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <KeyRound className={cn("size-3", p.key.set ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground/60")} />
          {keyLabel(p)} · {p.models.length} {p.models.length === 1 ? "model" : "models"}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant={editing ? "secondary" : "ghost"} size="sm" onClick={onEdit}>
          {editing ? "Close" : "Edit"}
        </Button>
        {p.saved ? (
          <Button variant="ghost" size="icon-sm" aria-label={p.builtIn ? `Reset ${p.label}` : `Remove ${p.label}`} onClick={onDelete}>
            <Trash2 />
          </Button>
        ) : null}
      </div>
    </div>
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
}: {
  provider?: ProviderSetting
  onSaved: (s: SettingsState) => void
  onCancel: () => void
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
      ? `Using ${provider.key.envName}. Paste a key to save one here instead.`
      : `Saved key ends …${provider.key.last4 ?? "····"}. Leave blank to keep it.`
    : "Paste the API key"

  return (
    <div className="flex flex-col gap-3 bg-muted/30 px-3 py-4 sm:px-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Name</span>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Lyber" disabled={Boolean(provider)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Base URL</span>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" className="font-mono" spellCheck={false} autoCapitalize="off" />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium">API key</span>
        <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={keyHint} autoComplete="off" spellCheck={false} />
      </label>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium">Models</span>
          <span className="text-xs text-muted-foreground">{chosen.length} chosen</span>
          <Button variant="outline" size="sm" className="ml-auto" disabled={!baseUrl || busy !== null} onClick={fetchList}>
            {busy === "fetch" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Fetch models
          </Button>
        </div>
        {(found?.length ?? 0) > 8 ? <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter, e.g. abliterated" /> : null}
        {rows.length > 0 ? (
          <ul className="max-h-80 divide-y overflow-y-auto border-y bg-background">
            {rows.map(({ id, on }) => {
              const d = chosen.find((m) => m.id === id)
              return (
                <li key={id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5">
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <input type="checkbox" checked={on} onChange={() => toggle(id)} className="size-3.5 accent-primary" />
                    <span className="truncate font-mono text-xs">{id}</span>
                  </label>
                  {d ? (
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      in $
                      <input className="h-6 w-14 rounded border border-input bg-transparent px-1 text-xs" inputMode="decimal" value={d.input} placeholder="?" onChange={(e) => setPrice(id, "input", e.target.value)} aria-label={`${id} input price per 1M`} />
                      out $
                      <input className="h-6 w-14 rounded border border-input bg-transparent px-1 text-xs" inputMode="decimal" value={d.output} placeholder="?" onChange={(e) => setPrice(id, "output", e.target.value)} aria-label={`${id} output price per 1M`} />
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
            variant="outline"
            disabled={!manual.trim() || chosen.some((m) => m.id === manual.trim())}
            onClick={() => {
              setChosen([...chosen, { id: manual.trim(), input: "", output: "", context: null }])
              setManual("")
            }}
          >
            Add
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">A model with no price is billed at a high fallback price, so the spend cap trips early.</p>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button disabled={!label.trim() || !baseUrl.trim() || chosen.length === 0 || busy !== null} onClick={save}>
          {busy === "save" ? <Loader2 className="animate-spin" /> : <Check />} Save
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
