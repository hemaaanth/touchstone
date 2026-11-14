import { useEffect, useMemo, useRef, useState } from "react"
import { Check, Cloud, Container, Info, KeyRound, Link2, Loader2, Pencil, Plus, RefreshCw, Star, Trash2 } from "lucide-react"
import type { DiscoveredModel, ModelDraft, ProviderSetting, SettingsState } from "@/lib/types"
import { StalePageError, deleteProvider, discoverModels, fetchSettings, rotateConsoleToken, saveProvider, setDefaultModel, setExecution, setRpc, setRunBudget } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ProviderLogo } from "@/components/provider-logo"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Label, ListCard, ListLoading, ListPage, ListRow, ListSection, RowMenu, RowMenuItem, RowMenuSeparator, TruncatedText } from "@/components/page-parts"

// Settings: four short lists. Providers, Run budget, Execution, Console. A row never
// expands in place: a provider and Daytona open in a sheet, a new provider in
// a dialog. Keys go up once and never come back; the server returns only a
// masked state.

const badge = "h-[18px] px-1.5 text-[10.5px] font-normal text-muted-foreground"
const noKeyBadge = <Badge variant="outline" className={badge}>No key</Badge>
const defaultBadge = <Badge variant="secondary" className={badge}>Default</Badge>

// What the server says about the execution backend (settings.mjs executionState).
interface ExecutionSetting {
  backend: "local" | "daytona"
  saved: "local" | "daytona"
  envOverride: string | null
  // held: why a key is set but not sent. saved: a key is stored in Settings,
  // in use or held.
  key: { set: boolean; source: "settings" | "env" | null; envName: string | null; last4: string | null; held?: string | null; saved?: boolean }
  apiUrl: string
  // The server cut a user name, password, query or #part from apiUrl.
  apiUrlHidden?: boolean
  // The host DAYTONA_API_KEY is bound to, or null with no env key.
  envKeyHost?: string | null
  target: string
  envNames: { apiUrl: string | null; target: string | null }
  defaults: { apiUrl: string; target: string }
}

const executionOf = (s: SettingsState) => (s as SettingsState & { execution?: ExecutionSetting }).execution

export function SettingsPage({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<SettingsState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The provider open in the sheet. `open` stays apart from the id, so the
  // sheet keeps its content while it slides out.
  const [editing, setEditing] = useState<{ id: string; open: boolean } | null>(null)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<{ provider: ProviderSetting; open: boolean } | null>(null)
  const [daytona, setDaytona] = useState<{ open: boolean; use: boolean }>({ open: false, use: false })
  const sheet = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetchSettings().then(setSettings, (e) => setLoadError(String(e.message)))
  }, [])
  const apply = (s: SettingsState) => {
    setSettings(s)
    setError(null)
    onChanged()
  }
  const attempt = async (fn: () => Promise<SettingsState>) => {
    try {
      apply(await fn())
      return true
    } catch (e) {
      // A stale page is said once, by the app's notice (with Reload).
      if (!(e instanceof StalePageError)) setError(String((e as Error).message))
      return false
    }
  }

  if (!settings) {
    return (
      <ListPage title="Settings">
        {loadError ? (
          <p role="alert" className="text-xs leading-relaxed text-bad">
            {loadError}
          </p>
        ) : (
          <ListLoading label="Loading settings…" />
        )}
      </ListPage>
    )
  }

  const shown = editing ? settings.providers.find((p) => p.id === editing.id) : undefined
  const makeDefaultOf = (p: ProviderSetting) =>
    p.key.set && !settings.envOverride ? (alias: string) => attempt(() => setDefaultModel(p.id, alias)) : null
  const ex = executionOf(settings)

  return (
    <ListPage title="Settings">
      <SettingsRefusal text={error} />

      <ListSection
        title="Providers"
        description={settings.envOverride ? `The server fixes the provider to ${settings.envOverride}. Restart without PROVIDER to change it.` : undefined}
        action={
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add provider
          </Button>
        }
      >
        <ListCard aria-label="Providers">
          {settings.providers.map((p) => {
            const isDefault = settings.default.provider === p.id
            const first = p.models[0]?.alias
            const makeDefault = makeDefaultOf(p)
            const open = () => setEditing({ id: p.id, open: true })
            return (
              <ListRow
                key={p.id}
                icon={<ProviderLogo id={p.id} label={p.label} className="size-full rounded-none bg-transparent text-muted-foreground ring-0 [&>span]:size-4" />}
                title={p.label}
                badges={
                  isDefault || !p.key.set ? (
                    <>
                      {isDefault ? defaultBadge : null}
                      {p.key.set ? null : noKeyBadge}
                    </>
                  ) : null
                }
                meta={[<TruncatedText key="url" mono middle tail={18} text={p.baseUrl} />, plural(p.models.length, "model")]}
                menu={
                  <RowMenu label={`Actions for ${p.label}`}>
                    <RowMenuItem onClick={open}>
                      <Pencil /> Edit
                    </RowMenuItem>
                    <RowMenuItem disabled={isDefault || !makeDefault || !first} onClick={() => first && makeDefault?.(first)}>
                      <Star /> Make default
                    </RowMenuItem>
                    <RowMenuSeparator />
                    <RowMenuItem variant="destructive" disabled={!p.saved} onClick={() => setRemoving({ provider: p, open: true })}>
                      <Trash2 /> {p.builtIn ? "Reset" : "Remove"}
                    </RowMenuItem>
                  </RowMenu>
                }
                onOpen={open}
                active={editing?.open === true && editing.id === p.id}
              />
            )
          })}
        </ListCard>
      </ListSection>

      <BudgetSection settings={settings} onSave={(n) => attempt(() => setRunBudget(n))} />

      {ex ? (
        <ExecutionSection
          ex={ex}
          onUse={(backend) => attempt(() => setExecution({ backend }))}
          onOpenDaytona={(use) => setDaytona({ open: true, use })}
        />
      ) : null}

      <RpcSection settings={settings} onSaved={apply} />

      <ConsoleSection />

      <Sheet open={editing?.open === true && !!shown} onOpenChange={(open) => setEditing((d) => (d ? { ...d, open } : d))}>
        <SheetContent ref={sheet} initialFocus={sheet} className="gap-0 outline-none data-[side=right]:w-full data-[side=right]:sm:max-w-md">
          {shown ? (
            <ProviderEditor
              key={shown.id}
              frame="sheet"
              provider={shown}
              isDefault={settings.default.provider === shown.id}
              defaultAlias={settings.default.provider === shown.id ? settings.default.model : null}
              onMakeDefault={makeDefaultOf(shown)}
              onSaved={(s) => {
                apply(s)
                setEditing((d) => (d ? { ...d, open: false } : d))
              }}
              onCancel={() => setEditing((d) => (d ? { ...d, open: false } : d))}
              onDelete={shown.saved ? () => setRemoving({ provider: shown, open: true }) : undefined}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-h-[calc(100svh-2rem)] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add provider</DialogTitle>
            <DialogDescription>An OpenAI-compatible gateway. Fetch its models, then tick the ones runs may use.</DialogDescription>
          </DialogHeader>
          {adding ? (
            <ProviderEditor
              frame="dialog"
              onSaved={(s) => {
                apply(s)
                setAdding(false)
              }}
              onCancel={() => setAdding(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <RemoveProviderDialog
        provider={removing?.provider ?? null}
        open={removing?.open === true}
        onOpenChange={(open) => setRemoving((r) => (r ? { ...r, open } : r))}
        onRemoved={(s) => {
          apply(s)
          setRemoving((r) => (r ? { ...r, open: false } : r))
          setEditing((d) => (d ? { ...d, open: false } : d))
        }}
      />

      {ex ? (
        <Sheet open={daytona.open} onOpenChange={(open) => setDaytona((d) => ({ ...d, open }))}>
          <SheetContent className="gap-0 outline-none data-[side=right]:w-full data-[side=right]:sm:max-w-md">
            <DaytonaEditor
              ex={ex}
              use={daytona.use}
              onSaved={(s) => {
                apply(s)
                setDaytona((d) => ({ ...d, open: false }))
              }}
              onCancel={() => setDaytona((d) => ({ ...d, open: false }))}
            />
          </SheetContent>
        </Sheet>
      ) : null}
    </ListPage>
  )
}

// A URL field that wraps, so a long URL is read in full and never cut. A
// URL has no line breaks, so Enter submits the form and a pasted break goes.
function UrlField({ value, onChange, placeholder, disabled }: { value: string; onChange: (v: string) => void; placeholder: string; disabled?: boolean }) {
  return (
    <Textarea
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\s+/g, ""))}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return
        e.preventDefault()
        e.currentTarget.form?.requestSubmit()
      }}
      placeholder={placeholder}
      disabled={disabled}
      className="min-h-8 resize-none py-1.5 font-mono text-xs break-all md:text-xs"
      inputMode="url"
      spellCheck={false}
      autoCapitalize="off"
    />
  )
}

// The scheme, host and port of an http(s) URL, as the server compares them
// (redact-url.mjs originOf). "" when it is not one.
function originOf(url: string) {
  try {
    const u = new URL(url)
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : ""
  } catch {
    return ""
  }
}

// The host and port of a URL, lower case, as the server compares them.
function hostOf(url: string) {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ""
  }
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

// Where a key comes from. The key itself never reaches the browser.
function keyNote(key: { set: boolean; source: "settings" | "env" | null; envName?: string | null; last4: string | null; held?: string | null }): string {
  if (!key.set) return key.held ?? "No API key"
  if (key.source === "env") return `Key from ${key.envName ?? "the server environment"}`
  return key.last4 ? `Key saved in Settings, ends ${key.last4}` : "Key saved in Settings"
}

// The star that marks the default model, inside the provider editor. The
// default's star is filled; any other star makes its model the default. A star
// that cannot be used (no key, or the server fixes the provider) stays dim.
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

// ---- Run budget

function BudgetSection({ settings, onSave }: { settings: SettingsState; onSave: (n: number) => Promise<boolean> }) {
  const saved = settings.spend.budgetUsd
  const spend = settings.spend
  const [value, setValue] = useState(String(saved))
  const [busy, setBusy] = useState(false)
  const n = Number(value)
  const valid = Number.isFinite(n) && n >= 0.01 && n <= 1000
  const money = (x: number) => `$${x.toFixed(2)}`
  const capped = spend.usd != null && spend.capUsd != null && spend.usd >= spend.capUsd
  const capAlert = spend.ledgerError
    ? `${spend.ledgerError} New runs are refused until this is fixed.`
    : capped
      ? "The total spend cap is reached. New runs are refused."
      : null
  return (
    <ListSection title="Run budget">
      <ListCard aria-label="Run budget">
        <ListRow
          title="Default per run"
          meta={[
            valid ? (
              "Each new run starts with this budget"
            ) : (
              <span key="bad" role="alert" className="min-w-0">
                Enter $0.01 to $1,000.
              </span>
            ),
          ]}
          trailing={
            <form
              className="flex items-center gap-2"
              onSubmit={async (e) => {
                e.preventDefault()
                if (!valid || n === saved || busy) return
                setBusy(true)
                await onSave(n)
                setBusy(false)
              }}
            >
              <span className="relative flex items-center">
                <span aria-hidden className="pointer-events-none absolute left-2.5 text-xs text-muted-foreground">
                  $
                </span>
                <Input
                  aria-label="Default budget per run, in US dollars"
                  className="h-8 w-24 pl-6 text-xs tabular-nums md:text-xs"
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  aria-invalid={!valid}
                />
              </span>
              {valid && n !== saved ? (
                <Button type="submit" variant="outline" size="sm" disabled={busy}>
                  {busy ? <Loader2 className="animate-spin" /> : "Save"}
                </Button>
              ) : null}
            </form>
          }
        />
        <ListRow
          title="Total spend cap"
          meta={[
            capAlert ? (
              <span key="alert" role="alert" className="min-w-0">
                {capAlert}
              </span>
            ) : (
              "All runs together stop here. Set by the server."
            ),
          ]}
          trailing={
            <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
              {spend.usd != null && spend.capUsd != null
                ? `${money(spend.usd)} spent of ${money(spend.capUsd)}`
                : spend.capUsd != null
                  ? money(spend.capUsd)
                  : "Unknown"}
            </span>
          }
        />
      </ListCard>
    </ListSection>
  )
}

// ---- Providers

const draftOf = (m: { id: string; input: number | null; output: number | null; context: number | null }, priced = true): ModelDraft => ({
  id: m.id,
  input: priced && m.input != null ? String(m.input) : "",
  output: priced && m.output != null ? String(m.output) : "",
  context: m.context,
})

// Add or edit one provider. "Fetch models" lists what the gateway serves for
// this key (GET /models, free). The operator ticks the models runs may use.
// `frame` says where it sits: in the edit sheet, or in the Add dialog. The
// fields sit straight on the sheet or the dialog, in no box of their own.
function ProviderEditor({
  frame,
  provider,
  isDefault = false,
  defaultAlias = null,
  onMakeDefault = null,
  onSaved,
  onCancel,
  onDelete,
}: {
  frame: "sheet" | "dialog"
  provider?: ProviderSetting
  isDefault?: boolean
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
  // Why the provider's key was not sent with Fetch models (another host).
  const [fetchNote, setFetchNote] = useState<string | null>(null)

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
  const setPrice = (id: string, field: "input" | "output", value: string) => setChosen(chosen.map((m) => (m.id === id ? { ...m, [field]: value } : m)))

  const fetchList = async () => {
    setBusy("fetch")
    setError(null)
    setFetchNote(null)
    try {
      const r = await discoverModels({ id: provider?.id, baseUrl, apiKey: apiKey || undefined })
      setFound(r.models)
      setFetchNote(r.keyNote ?? null)
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
  const canSave = Boolean(label.trim() && baseUrl.trim() && chosen.length > 0 && busy === null)
  // A key goes only to its own server (scheme, host and port): a save to
  // another server drops a saved key (settings.mjs saveProvider), and an env
  // key goes only to the built-in base URL (providers.mjs providerKey).
  const typedOrigin = originOf(baseUrl.trim())
  const savedOrigin = originOf(provider?.baseUrl ?? "")
  const k = provider?.key
  const serverLine =
    !k || apiKey.trim() || typedOrigin === ""
      ? null
      : k.source === "settings" && typedOrigin !== savedOrigin
        ? "Changing the server removes the saved key."
        : (k.source === "env" || k.held) && k.envName && k.envHome && typedOrigin !== k.envHome
          ? `The key from ${k.envName} is only sent to ${k.envHome}.`
          : null

  const fields = (
    <>
      {provider ? null : (
        <label className="flex flex-col gap-2">
          <Label>Name</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My gateway" />
        </label>
      )}
      <label className="flex flex-col gap-2">
        <Label>Base URL</Label>
        <UrlField value={baseUrl} onChange={setBaseUrl} placeholder="https://api.example.com/v1" />
        {provider?.baseUrlHidden ? <span className="text-xs text-muted-foreground">This URL holds parts that are not shown. They stay unless you edit it.</span> : null}
        {serverLine ? <span className="text-xs text-muted-foreground">{serverLine}</span> : null}
      </label>
      <label className="flex flex-col gap-2">
        <Label>API key</Label>
        <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={keyHint} autoComplete="off" spellCheck={false} />
      </label>

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Label>Models</Label>
          <Button variant="ghost" size="sm" className="-my-1 -mr-2 ml-auto" disabled={!baseUrl || busy !== null} onClick={fetchList}>
            {busy === "fetch" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Fetch models
          </Button>
        </div>
        {fetchNote ? <span className="text-xs text-muted-foreground">{fetchNote}</span> : null}
        {(found?.length ?? 0) > 8 ? <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter, e.g. abliterated" aria-label="Filter models" /> : null}
        {rows.length > 0 ? (
          <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border">
            {rows.map(({ id, on }) => {
              const d = chosen.find((m) => m.id === id)
              // A saved model can be the default; a model ticked in this edit
              // cannot until it is saved.
              const alias = provider?.models.find((m) => m.id === id)?.alias
              return (
                <li key={id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-1.5">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggle(id)}
                    className="flex min-w-0 flex-1 basis-full items-center gap-2 rounded-md py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:basis-0"
                  >
                    <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-[5px] transition-colors", on ? "bg-foreground text-background" : "bg-foreground/10")}>
                      {on ? <Check className="size-3" strokeWidth={3} /> : null}
                    </span>
                    <span className={cn("min-w-0 font-mono text-xs break-all", !on && "text-muted-foreground")}>{id}</span>
                  </button>
                  {d ? (
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground" title="USD per 1M tokens. A model with no price is charged a high fallback price.">
                      in $
                      <input
                        className="h-6 w-14 rounded-md bg-muted px-1.5 text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        inputMode="decimal"
                        value={d.input}
                        placeholder="?"
                        onChange={(e) => setPrice(id, "input", e.target.value)}
                        aria-label={`${id} input price per 1M`}
                      />
                      out $
                      <input
                        className="h-6 w-14 rounded-md bg-muted px-1.5 text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        inputMode="decimal"
                        value={d.output}
                        placeholder="?"
                        onChange={(e) => setPrice(id, "output", e.target.value)}
                        aria-label={`${id} output price per 1M`}
                      />
                      /1M
                    </span>
                  ) : null}
                  {on && alias ? <DefaultStar on={alias === defaultAlias} label={id} onPick={onMakeDefault ? () => onMakeDefault(alias) : null} /> : null}
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No models yet. Fetch them, or add an id by hand.</p>
        )}
        <div className="flex gap-2">
          <Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Add a model id by hand" aria-label="Model id" className="font-mono text-xs md:text-xs" spellCheck={false} autoCapitalize="off" />
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
      </section>

      {error ? (
        <p role="alert" className="text-xs leading-relaxed text-bad">
          {error}
        </p>
      ) : null}
    </>
  )

  const saveButton = (
    <Button size="sm" disabled={!canSave} onClick={save}>
      {busy === "save" ? <Loader2 className="animate-spin" /> : <Check />} Save
    </Button>
  )

  if (frame === "dialog") {
    return (
      <>
        <div className="flex min-w-0 flex-col gap-4">{fields}</div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          {saveButton}
        </DialogFooter>
      </>
    )
  }

  const p = provider as ProviderSetting
  return (
    <>
      <SheetHeader className="flex-row items-start gap-3 pr-12">
        <span aria-hidden className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <ProviderLogo id={p.id} label={p.label} className="size-full rounded-none bg-transparent text-muted-foreground ring-0 [&>span]:size-4" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <SheetTitle className="leading-snug wrap-anywhere">{p.label}</SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-1.5 text-xs">
            {keyNote(p.key)}
            {isDefault ? defaultBadge : null}
          </SheetDescription>
        </div>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-1 pb-6">{fields}</div>
      <SheetFooter className="flex-row flex-wrap items-center border-t">
        {saveButton}
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        {onDelete ? (
          <Button variant="outline" size="sm" className="ml-auto text-muted-foreground hover:text-destructive" onClick={onDelete}>
            <Trash2 /> {p.builtIn ? "Reset" : "Remove"}
          </Button>
        ) : null}
      </SheetFooter>
    </>
  )
}

function RemoveProviderDialog({
  provider,
  open,
  onOpenChange,
  onRemoved,
}: {
  provider: ProviderSetting | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onRemoved: (s: SettingsState) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reset = provider?.builtIn === true
  const remove = async () => {
    if (!provider) return
    setBusy(true)
    setError(null)
    try {
      onRemoved(await deleteProvider(provider.id))
    } catch (e) {
      setError(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        if (next) setError(null)
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="pr-6 wrap-anywhere">{reset ? `Reset ${provider?.label}?` : `Remove ${provider?.label}?`}</DialogTitle>
          <DialogDescription>{reset ? "This removes its saved key and models. The built-in entry stays." : "It leaves the list with its saved key and models."}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-xs text-bad">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
          <Button variant="destructive" disabled={busy} onClick={remove}>
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
            {reset ? "Reset" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---- Console: rotate the console token. The token itself is never shown.

function ConsoleSection() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rotated, setRotated] = useState(false)
  const rotate = async () => {
    setBusy(true)
    setError(null)
    try {
      await rotateConsoleToken()
      setRotated(true)
      setOpen(false)
    } catch (e) {
      setError(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ListSection title="Console">
      <ListCard aria-label="Console">
        <ListRow
          icon={<KeyRound />}
          title="Console token"
          meta={[rotated ? "Rotated. Other open console tabs need a reload." : "Every change from the console carries it"]}
          trailing={
            <Button variant="outline" size="sm" onClick={() => { setError(null); setOpen(true) }}>
              Rotate
            </Button>
          }
        />
      </ListCard>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (busy) return
          if (next) setError(null)
          setOpen(next)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="pr-6">Rotate the console token?</DialogTitle>
            <DialogDescription>The old token stops working at once. This page keeps working; other open console tabs need a reload.</DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-xs text-bad">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
            <Button variant="destructive" disabled={busy} onClick={rotate}>
              {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
              Rotate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ListSection>
  )
}

// ---- Execution: where a run's tools run. Local Docker is the default.

// The Daytona details, behind the info icon next to its name. They are not
// repeated anywhere on the page.
const DAYTONA_NOTES = [
  "Solidity analyzers, fuzzers, secret scans, forge builds and the proof replay run on a Daytona machine. The proof verdict is copied back.",
  "Daytona gets the run workspace, with any keys in its files.",
  "Networked tools, the lab chain, image builds, and the supply-chain, infra-cloud and domains scans stay in local Docker.",
  "Each run and each fleet child gets its own machine, deleted when it ends. If Daytona fails, the tool runs in local Docker.",
]

function DaytonaInfo() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="What runs on Daytona"
            onClick={(e) => e.stopPropagation()}
            className="flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        }
      >
        <Info className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="flex max-w-sm flex-col items-start gap-1.5 text-left leading-relaxed">
        {DAYTONA_NOTES.map((n) => (
          <span key={n}>{n}</span>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

// The in-use backend says so; the other one has a Use button.
function UseControl({ on, name, disabled, onUse }: { on: boolean; name: string; disabled: boolean; onUse: () => Promise<unknown> | void }) {
  const [busy, setBusy] = useState(false)
  if (on) {
    return (
      <span className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
        <Check className="size-3.5" /> In use
      </span>
    )
  }
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled || busy}
      aria-label={`Use ${name}`}
      onClick={async (e) => {
        e.stopPropagation()
        setBusy(true)
        await onUse()
        setBusy(false)
      }}
    >
      {busy ? <Loader2 className="animate-spin" /> : null} Use
    </Button>
  )
}

function ExecutionSection({
  ex,
  onUse,
  onOpenDaytona,
}: {
  ex: ExecutionSetting
  onUse: (backend: "local" | "daytona") => Promise<boolean>
  onOpenDaytona: (use: boolean) => void
}) {
  const fixed = Boolean(ex.envOverride)
  return (
    <ListSection
      title="Execution"
      description={fixed ? `The server fixes execution to ${ex.envOverride}. Restart without TOUCHSTONE_EXEC to change it.` : undefined}
    >
      <ListCard aria-label="Where tools run">
        <ListRow
          icon={<Container />}
          title="Local Docker"
          meta={["Tools run on this machine"]}
          trailing={<UseControl on={ex.backend === "local"} name="Local Docker" disabled={fixed} onUse={() => onUse("local")} />}
        />
        <ListRow
          icon={<Cloud />}
          title="Daytona"
          badges={
            <>
              <DaytonaInfo />
              {ex.key.set ? null : noKeyBadge}
            </>
          }
          meta={["Tools run on remote machines, one per run"]}
          trailing={
            <UseControl
              on={ex.backend === "daytona"}
              name="Daytona"
              disabled={fixed}
              // With no key, Use opens the form first.
              onUse={() => (ex.key.set ? onUse("daytona") : onOpenDaytona(true))}
            />
          }
          onOpen={() => onOpenDaytona(false)}
        />
      </ListCard>
    </ListSection>
  )
}

// The Daytona form: key, server URL and region. An empty URL or region means
// the default. A server env var wins over a saved value, so its field is
// read-only and says so.
function DaytonaEditor({ ex, use, onSaved, onCancel }: { ex: ExecutionSetting; use: boolean; onSaved: (s: SettingsState) => void; onCancel: () => void }) {
  const [apiKey, setApiKey] = useState("")
  const [apiUrl, setApiUrl] = useState(ex.envNames.apiUrl || ex.apiUrl === ex.defaults.apiUrl ? "" : ex.apiUrl)
  const [target, setTarget] = useState(ex.envNames.target || ex.target === ex.defaults.target ? "" : ex.target)
  const [busy, setBusy] = useState<"save" | "clear" | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Daytona in use, or about to be, needs a key: the server refuses it without one.
  const inUse = use || ex.saved === "daytona"
  // A key goes only to the host it is bound to: a new host drops a saved key
  // (settings.mjs) and holds back DAYTONA_API_KEY (daytona.mjs execConfig).
  // A URL that is not valid counts as no move: the server says what is wrong.
  const typedHost = ex.envNames.apiUrl ? hostOf(ex.apiUrl) : hostOf(apiUrl.trim() || ex.defaults.apiUrl)
  const moved = typedHost !== "" && typedHost !== hostOf(ex.apiUrl)
  // Is there a key for the server after this save? A typed key, the key in
  // use if the host stays, or DAYTONA_API_KEY if it is bound to the new host.
  const keyAfter = Boolean(apiKey.trim()) || (ex.key.set && !moved) || (moved && ex.envKeyHost === typedHost)
  const blocked = inUse && !keyAfter
  const keyLine =
    !moved || apiKey.trim()
      ? null
      : blocked
        ? "Daytona is in use: enter the key for the new server."
        : ex.key.source === "settings"
          ? "Changing the server removes the saved key."
          : ex.key.source === "env"
            ? "The key from DAYTONA_API_KEY is not sent to another server."
            : null

  const send = async (kind: "save" | "clear", body: Parameters<typeof setExecution>[0]) => {
    setBusy(kind)
    setError(null)
    try {
      onSaved(await setExecution(body))
    } catch (e) {
      setError(String((e as Error).message))
    } finally {
      setBusy(null)
    }
  }
  const save = () =>
    send("save", {
      backend: use ? "daytona" : ex.saved,
      apiKey: apiKey.trim() || undefined,
      apiUrl: ex.envNames.apiUrl ? undefined : apiUrl.trim(),
      target: ex.envNames.target ? undefined : target.trim(),
    })

  const keyHint = !ex.key.set
    ? "Paste the Daytona API key"
    : ex.key.source === "env"
      ? `Leave blank to keep the key from ${ex.key.envName ?? "the server"}`
      : `Leave blank to keep …${ex.key.last4 ?? "····"}`

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        if (!busy && !blocked) save()
      }}
    >
      <SheetHeader className="flex-row items-start gap-3 pr-12">
        <span aria-hidden className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
          <Cloud />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <SheetTitle className="leading-snug">Daytona</SheetTitle>
          <SheetDescription className="text-xs">{keyNote(ex.key)}</SheetDescription>
        </div>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-1 pb-6">
        <label className="flex flex-col gap-2">
          <Label>API key</Label>
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={keyHint} autoComplete="off" spellCheck={false} />
        </label>
        <label className="flex flex-col gap-2">
          <Label>Server URL</Label>
          <UrlField value={ex.envNames.apiUrl ? ex.apiUrl : apiUrl} onChange={setApiUrl} placeholder={ex.defaults.apiUrl} disabled={Boolean(ex.envNames.apiUrl)} />
          {ex.envNames.apiUrl ? <span className="text-xs text-muted-foreground">Set by {ex.envNames.apiUrl} on the server.</span> : null}
          {ex.apiUrlHidden ? <span className="text-xs text-muted-foreground">This URL holds parts that are not shown.</span> : null}
          {keyLine ? <span className="text-xs text-muted-foreground">{keyLine}</span> : null}
        </label>
        <label className="flex flex-col gap-2">
          <Label>Region</Label>
          <Input
            value={ex.envNames.target ? ex.target : target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={ex.defaults.target}
            disabled={Boolean(ex.envNames.target)}
            className="font-mono text-xs md:text-xs"
            spellCheck={false}
            autoCapitalize="off"
          />
          {ex.envNames.target ? <span className="text-xs text-muted-foreground">Set by {ex.envNames.target} on the server.</span> : null}
        </label>
        {error ? (
          <p role="alert" className="text-xs leading-relaxed text-bad">
            {error}
          </p>
        ) : null}
      </div>
      <SheetFooter className="flex-row flex-wrap items-center border-t">
        <Button type="submit" size="sm" disabled={busy !== null || blocked}>
          {busy === "save" ? <Loader2 className="animate-spin" /> : <Check />} {use ? "Save and use" : "Save"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        {ex.key.saved ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto text-muted-foreground hover:text-destructive"
            // A held key can go too. With Daytona in use and no env key, the
            // server would refuse: switch to local Docker first.
            disabled={busy !== null || (ex.saved === "daytona" && ex.key.source !== "env")}
            title={ex.saved === "daytona" && ex.key.source !== "env" ? "Use local Docker first" : undefined}
            onClick={() => send("clear", { backend: ex.saved, clearKey: true })}
          >
            {busy === "clear" ? <Loader2 className="animate-spin" /> : <Trash2 />} Remove key
          </Button>
        ) : null}
      </SheetFooter>
    </form>
  )
}

// A refused settings write. It is one line in the gap under the page title, so
// the page never moves when it comes or goes, and it covers nothing. The box
// takes no room of its own: its negative margin gives back the gap it adds. A
// long sentence is cut on screen; the tooltip and a screen reader get it whole.
export function SettingsRefusal({ text }: { text: string | null }) {
  return (
    <div className="relative -mt-6 h-0">
      {text ? (
        <p role="alert" title={text} className="absolute inset-x-0 top-[3px] truncate text-xs leading-[18px] text-bad">
          {text}
        </p>
      ) : null}
    </div>
  )
}

// A chain RPC for forked replays. A replay that lands on real deployed state reads
// one chain; without a URL that chain's fork fails loudly rather than quietly
// testing something else. The URL is a credential, so this row never shows it: it
// shows which key is set by its last four characters, exactly as a provider key
// does.
export function RpcSection({ settings, onSaved }: { settings: SettingsState; onSaved: (s: SettingsState) => void }) {
  const rows = settings.rpc ?? []
  const [editing, setEditing] = useState<{ chain: string; open: boolean } | null>(null)
  const [url, setUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = editing?.open === true
  const row = rows.find((r) => r.chain === editing?.chain) ?? null
  const save = async () => {
    if (!editing) return
    setBusy(true)
    setError(null)
    try {
      onSaved(await setRpc({ chain: editing.chain, url }))
      setEditing(null)
      setUrl("")
    } catch (e) {
      setError(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ListSection
      title="Chain RPCs"
      description="A forked replay reads one real chain at a pinned block. Add the chains your targets live on; a run with no RPC for its chain stops and says so."
    >
      <ListCard aria-label="Chain RPCs">
        {rows.map((r) => (
          <ListRow
            key={r.chain}
            icon={<Link2 />}
            title={r.chain}
            meta={[
              r.set
                ? `${r.source === "env" ? `From ${r.envName}` : "Saved"} · ends ${r.last4 ?? "?"}`
                : "Not set — a fork on this chain cannot run",
            ]}
            trailing={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setError(null)
                  setUrl("")
                  setEditing({ chain: r.chain, open: true })
                }}
              >
                {r.set ? "Replace" : "Add"}
              </Button>
            }
          />
        ))}
      </ListCard>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (busy) return
          if (next) setError(null)
          setEditing(next ? editing : null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{row?.set ? "Replace the RPC" : "Add an RPC"}</DialogTitle>
            <DialogDescription>
              {editing?.chain ? `An https URL for ${editing.chain}. A key in the path or query is fine; a username and password in the URL is not.` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label>RPC URL</Label>
            <Input
              id="rpc-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              autoComplete="off"
              spellCheck={false}
            />
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
            <Button onClick={() => void save()} disabled={busy || !url.trim()}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ListSection>
  )
}
