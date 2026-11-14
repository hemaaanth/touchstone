import { useRef, useState } from "react"
import { FileCode2, FlaskConical, Folder, FolderGit2, Globe, Loader2, Plus, Upload, X } from "lucide-react"
import type { ModelChoice, PackChoice, RoamSelection, RunMode, TargetChoice } from "@/lib/types"
import { attachScope, type ScopeMember } from "@/lib/api"
import { DEFAULT_PACK, isOwnScope, packOf, plural } from "@/lib/catalog"
import { cn } from "@/lib/utils"
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"

const RANDOM = "random"
const DEFAULT_BUDGET = "5.00"

const MODES: { value: RunMode; label: string; hint: string }[] = [
  { value: "fleet", label: "Fleet", hint: "The coordinator splits the scope across agents. More areas, more agents." },
  { value: "solo", label: "Solo", hint: "One agent works the whole scope." },
]
const MODE_KEY = "ts.runMode"

// The New Run window picks the scope, its modules, Fleet or Solo, and budget.
// A scope allows one or more modules; the selected modules share one run.
// The model is the server's default, so there is no model picker.
// "Random" omits targetId, so the server picks and repeat runs do not re-break
// one bug. Scopes are added on the Scopes page.
export function NewRunDialog({
  open,
  onOpenChange,
  models,
  targets,
  packs,
  busy,
  error,
  setupError = null,
  roamReady = false,
  onOpenSettings,
  onStart,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  models: ModelChoice[]
  targets: TargetChoice[]
  packs: PackChoice[]
  busy: boolean
  error: string | null
  setupError?: string | null
  roamReady?: boolean
  onOpenSettings?: () => void
  // One run covers every module in `modules`.
  onStart: (alias: string, targetId: string | undefined, budgetUsd: number, modules: string[], mode: RunMode, roam: RoamSelection) => void
}) {
  const alias = models[0]?.alias ?? ""
  // The modules a scope allows that the server also lists.
  const allowed = (t: TargetChoice) => (t.packs ?? [packOf(t)]).flatMap((id) => packs.find((p) => p.id === id) ?? [])
  const runnable = targets.filter((t) => t.runnable && allowed(t).length > 0)
  const [scopeId, setScopeId] = useState(RANDOM)
  const [ticked, setTicked] = useState<string[]>([])
  const [modulesMissing, setModulesMissing] = useState(false)
  const [budget, setBudget] = useState(DEFAULT_BUDGET)
  // The last choice sticks, so an operator who runs fleets keeps getting one.
  const [mode, setModeState] = useState<RunMode>(() => (localStorage.getItem(MODE_KEY) === "solo" ? "solo" : "fleet"))
  const [freeRoam, setFreeRoam] = useState(true)
  const setMode = (m: RunMode) => {
    setModeState(m)
    localStorage.setItem(MODE_KEY, m)
  }

  const scope = runnable.find((t) => t.id === scopeId) ?? null
  const eligible = scope ? allowed(scope) : packs.filter((p) => p.id === DEFAULT_PACK)
  // A scope with one module needs no tick. A random scope runs the default module.
  const modules = !scope ? [DEFAULT_PACK] : eligible.length === 1 ? [eligible[0].id] : eligible.filter((p) => ticked.includes(p.id)).map((p) => p.id)
  const budgetN = Number(budget.replace(/^\$/, "").trim())
  const budgetOk = Number.isFinite(budgetN) && budgetN >= 0.01 && budgetN <= 1000
  const needsRoamSetup = mode === "fleet" && freeRoam && !roamReady
  const canStart = !needsRoamSetup && alias !== "" && !setupError && runnable.length > 0 && !busy && budgetOk

  const submit = () => {
    if (!canStart) return
    if (modules.length === 0) {
      setModulesMissing(true)
      return
    }
    onStart(alias, scope?.id, budgetN, modules, mode, { freeRoam: mode === "fleet" && freeRoam, options: [] })
  }

  const own = (target: TargetChoice) => isOwnScope(target.id) || target.kind === "live"
  const scopeGroups = [
    { label: "Your scopes", targets: runnable.filter(own) },
    { label: "Demo scopes", targets: runnable.filter((target) => !own(target)) },
  ]
  const scopeItems = [{ value: RANDOM, label: "Random scope" }, ...scopeGroups.flatMap((group) => group.targets.map((t) => ({ value: t.id, label: t.title })))]
  const demoBadge = <Badge variant="outline" className="h-[18px] shrink-0 px-1.5 text-[10.5px] font-normal text-muted-foreground">Demo</Badge>

  const notice = setupError || (needsRoamSetup ? "Set up and test Daytona in Settings to use free-roam agents. You can also turn off free-roam agents for this run." : null) || (!budgetOk
    ? "The budget must be between $0.01 and $1,000."
    : alias === ""
      ? "Set up a provider key and model in Settings. NEAR AI Cloud is recommended."
      : runnable.length === 0
        ? "No runnable scopes are available right now."
        : error)

  const label = "text-[11px] leading-[15px] font-semibold tracking-[0.06em] text-muted-foreground"
  const field = "h-9 w-full rounded-lg border-input bg-background px-3 text-[13px]"

  return (
    <Dialog open={open} onOpenChange={(next, details) => {
      if (!next && modulesMissing && details.reason === "escape-key") {
        setModulesMissing(false)
        return
      }
      onOpenChange(next)
    }}>
      <DialogContent className="flex max-h-[calc(100svh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[440px]" showCloseButton={false}>
        <div className="flex h-12 shrink-0 items-center border-b px-5">
          <DialogTitle className="text-sm font-semibold">New run</DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" className="-mr-2 ml-auto text-muted-foreground" />}
          >
            <X />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>

        <form
          className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pt-4 pb-5"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <span className={label} id="new-run-scope">SCOPE</span>
            <Select
              items={scopeItems}
              value={scopeId}
              onValueChange={(v) => {
                if (!v) return
                setScopeId(String(v))
                setTicked([])
                setModulesMissing(false)
              }}
            >
              <SelectTrigger className={field} aria-labelledby="new-run-scope">
                <SelectValue className="min-w-0 truncate" />
                {scope && !own(scope) ? demoBadge : null}
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} className="p-1">
                <SelectItem value={RANDOM} className="text-[13px]"><span className="min-w-0 flex-1 truncate">Random scope</span></SelectItem>
                {scopeGroups.filter((group) => group.targets.length > 0).map((group) => (
                  <SelectGroup key={group.label} className="p-0">
                    <SelectLabel>{group.label}</SelectLabel>
                    {group.targets.map((target) => (
                      <SelectItem key={target.id} value={target.id} className="text-[13px]">
                        <span className="min-w-0 flex-1 truncate">{target.title}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>

            <div className="flex flex-col gap-1.5" role="group" aria-labelledby="new-run-modules">
              <span className={label} id="new-run-modules">MODULES</span>
              <div className="flex h-28 shrink-0 flex-col overflow-y-auto rounded-lg border border-input bg-background py-1">
                {eligible.map((p) => (
                  <label key={p.id} className={cn("flex h-8 shrink-0 items-center gap-2.5 px-3 text-[13px]", eligible.length > 1 && "cursor-pointer")}>
                    <input
                      type="checkbox"
                      checked={modules.includes(p.id)}
                      disabled={busy || eligible.length === 1}
                      onChange={(e) => {
                        setModulesMissing(false)
                        setTicked((list) => (e.target.checked ? [...list, p.id] : list.filter((id) => id !== p.id)))
                      }}
                      className="size-3.5 shrink-0 accent-foreground"
                    />
                    {p.title}
                  </label>
                ))}
              </div>
            </div>

          <div className="flex flex-col gap-1.5">
            <span className={label} id="new-run-mode">AGENTS</span>
            <div
              role="radiogroup"
              aria-labelledby="new-run-mode"
              className="grid h-9 grid-cols-2 gap-0.5 rounded-lg border border-input bg-muted/40 p-0.5"
            >
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.value}
                  onClick={() => setMode(m.value)}
                  className={cn(
                    "rounded-md text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    mode === m.value
                      ? "bg-background font-medium text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="grid text-xs text-muted-foreground">
              {MODES.map((m) => (
                <span key={m.value} aria-hidden={mode !== m.value} className={cn("col-start-1 row-start-1", mode !== m.value && "invisible")}>{m.hint}</span>
              ))}
            </div>
          </div>

          <fieldset disabled={busy || mode !== "fleet"} aria-hidden={mode !== "fleet"} className={cn("flex flex-col gap-2 text-xs", mode !== "fleet" && "invisible")}>
            <label className="flex items-center gap-2"><input type="checkbox" checked={freeRoam} onChange={(e) => setFreeRoam(e.target.checked)} />Allow free-roam agents</label>
            <p className="text-muted-foreground">Free-roam agents use a remote sandbox. Their session candidates remain unproven.</p>
          </fieldset>

          <label className="flex flex-col gap-1.5">
            <span className={label}>BUDGET</span>
            <span
              className={cn(
                "flex h-9 items-center rounded-lg border border-input bg-background px-3 text-[13px] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
                !budgetOk && "border-bad",
              )}
            >
              <span>$</span>
              <input
                className="min-w-0 flex-1 bg-transparent tabular-nums outline-none"
                inputMode="decimal"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                aria-label="Budget for this run in USD"
              />
              <span className="shrink-0 text-muted-foreground/60">Run stops at this limit</span>
            </span>
          </label>

          {notice ? <p role="alert" className="text-xs text-bad">{notice}</p> : null}
          {(setupError || needsRoamSetup || alias === "") && onOpenSettings ? (
            <Button type="button" variant="outline" onClick={onOpenSettings}>{needsRoamSetup ? "Set up Daytona" : "Set up provider"}</Button>
          ) : null}
        </form>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3.5">
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Popover open={open && modulesMissing && modules.length === 0} onOpenChange={(next) => { if (!next) setModulesMissing(false) }}>
            <PopoverTrigger onClick={submit} render={<Button disabled={!canStart} />}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              Start run
            </PopoverTrigger>
            <PopoverContent side="top" align="end" initialFocus={false} aria-label="Modules required" className="w-auto max-w-64 text-xs">
              <p role="alert">Select at least one module.</p>
            </PopoverContent>
          </Popover>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// A scope's kind, as an icon: a lab, local folders, or linked repos. A mixed
// scope with any repo shows the repo icon, else the folder icon.
export function ScopeIcon({ target: t }: { target: Pick<TargetChoice, "kind" | "links"> }) {
  if (t.kind === "live") return <Globe />
  if (t.kind === "lab") return <FlaskConical />
  if (t.kind === "local-source") return <Folder />
  if (t.kind === "scope") return t.links?.length ? <FolderGit2 /> : <Folder />
  return t.links?.length ? <FolderGit2 /> : <FileCode2 />
}

// Which files of a picked folder are sent. This mirrors classifyPath in
// spike/lib/scopes-store.mjs, and the server checks again. It runs on the path
// alone, before any file is read, so a secret file is never read or sent.
const SKIP_DIRS = new Set([
  "node_modules", "out", "cache", "broadcast", "artifacts", "build", "dist",
  "target", "coverage", "venv", "__pycache__", "bower_components", "vendor",
])
const SOURCE_EXT = new Set([
  "sol", "vy", "move", "cairo", "fe", "huff", "yul",
  "rs", "go", "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py", "rb", "java", "kt", "kts",
  "swift", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "fs", "php", "scala", "ex", "exs", "erl",
  "hs", "ml", "mli", "zig", "nim", "lua", "dart", "clj", "r", "jl", "sh", "bash", "zsh", "ps1", "sql",
  "html", "htm", "css", "scss", "sass", "less", "vue", "svelte", "astro", "graphql", "gql",
  "json", "jsonc", "json5", "yaml", "yml", "toml", "xml", "ini", "cfg", "conf", "proto", "md", "mdx",
  "txt", "rst", "tf", "hcl", "nix", "gradle", "mod", "sum", "lock", "csv",
])
const SOURCE_NAMES = new Set(["Dockerfile", "Makefile", "Gemfile", "Procfile", "Rakefile", "Justfile", "LICENSE", "README", "CODEOWNERS"])
const SECRET_NAME = [
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn|gpg|asc|crt|cer|der)$/i,
  /^(secrets?|credentials?|service[-_]?account)(\.[\w-]+)?\.(json|ya?ml|toml|txt|ini)$/i,
  /^(secrets?|credentials?)$/i,
  /^wallet\.dat$/i,
  /^(keystore|mnemonic|seed)(\.[\w-]+)?\.(json|txt)$/i,
  /^env$/i,
  /\.env$/i,
]
const SANDBOX_CONFIG = new Set(["foundry.toml", "remappings.txt"])
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/
const MAX_FILES = 4000
const MAX_BYTES = 40 * 1024 * 1024

// Keep one path? Foundry keeps dependencies in a top-level lib/, so lib/ is
// skipped only in a folder that has Solidity.
function keepPath(rel: string, solidity: boolean) {
  const parts = rel.split("/")
  const base = parts[parts.length - 1]
  if (parts.some((p) => !p || p.startsWith("."))) return false
  if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p)) || (solidity && parts.length > 1 && parts[0] === "lib")) return false
  if (SANDBOX_CONFIG.has(base) || SECRET_NAME.some((re) => re.test(base))) return false
  const dot = base.lastIndexOf(".")
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ""
  return ext ? SOURCE_EXT.has(ext) : SOURCE_NAMES.has(base)
}

// Read a picked folder into { path, content }, keeping only source text in any
// language. Paths are checked first; only kept files are read. The folder's own
// name is dropped from each path and becomes its label. Returns an error string
// when the kept files are over the scope limits, before reading any of them.
async function readFolder(list: FileList): Promise<{ name: string; files: { path: string; content: string }[] } | string> {
  const all = Array.from(list)
  const first = all[0]?.webkitRelativePath ?? ""
  const root = first.includes("/") ? first.split("/")[0] : ""
  const rel = (f: File) => (root ? f.webkitRelativePath.slice(root.length + 1) : f.name)
  const solidity = all.some((f) => rel(f).endsWith(".sol"))
  const keep = all.filter((f) => keepPath(rel(f), solidity))
  if (keep.length > MAX_FILES) return `${root || "This folder"} has ${keep.length} source files. A scope takes up to ${MAX_FILES}.`
  if (keep.reduce((n, f) => n + f.size, 0) > MAX_BYTES) return `${root || "This folder"} is over 40 MB of source. Pick a smaller folder.`
  const files: { path: string; content: string }[] = []
  for (const f of keep) {
    const content = await f.text()
    // A key block in an ordinary file: drop it here, so it never leaves the browser.
    if (PRIVATE_KEY_BLOCK.test(content) || content.includes("\u0000")) continue
    files.push({ path: rel(f), content })
  }
  // The server takes folder names of letters, digits, "-", "_" and ".".
  const name = root.replace(/[^\w.-]+/g, "-").replace(/^[.]+/, "").slice(0, 64) || "folder"
  return { name, files }
}

// The server takes only HTTPS GitHub repo, folder, or file URLs. Check here
// too, so a bad URL is refused when it is added, not when the scope is saved.
function githubUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  const ok =
    u.protocol === "https:" &&
    u.hostname === "github.com" &&
    !u.username &&
    !u.password &&
    !u.port &&
    /^\/[\w.-]+\/[\w.-]+(?:\/(?:tree|blob)\/.+)?\/?$/.test(u.pathname)
  if (!ok) return null
  u.search = ""
  u.hash = ""
  return u.href
}

const repoName = (url: string) => new URL(url).pathname.split("/")[2] ?? url

// A folder is a path on this machine, read in place by the server (the
// default), or files uploaded from the browser (the fallback).
type Source =
  | { kind: "repo"; url: string }
  | { kind: "contract"; chainId: number; address: string }
  | { kind: "folder"; name: string; path: string }
  | { kind: "folder"; name: string; files: { path: string; content: string }[] }
  | { kind: "site"; host: string; origin: string }

const sourceKey = (s: Source) =>
  s.kind === "contract" ? `eip155:${s.chainId}:${s.address.toLowerCase()}` : s.kind === "repo" ? s.url.replace(/\/+$/, "").replace(/\.git$/, "") : s.kind === "site" ? `site:${s.origin}` : "path" in s ? `path:${s.path}` : `folder:${s.name}`

// A folder path the operator typed: "/..." or "~/...". The server expands "~",
// resolves the path, and reads the folder. The name is its last part, made
// safe the same way the server does it.
function localPath(raw: string): { name: string; path: string } | null {
  const text = raw.trim().replace(/\/+$/, "")
  if (!(text.startsWith("/") || text === "~" || text.startsWith("~/"))) return null
  const base = text.split("/").filter(Boolean).pop() ?? ""
  const name = base === "~" ? "home" : base.replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "").slice(0, 64) || "folder"
  return { name, path: text }
}
const sourceLabel = (s: Source) => (s.kind === "contract" ? `eip155:${s.chainId}:${s.address}` : s.kind === "repo" ? repoName(s.url) : s.kind === "site" ? s.host : s.name)

// A wildcard entry the operator typed, "*.example.com": a grant pattern that
// covers every subdomain of example.com (never example.com itself). Returns the
// base name, or null. Only this one spelling: a star, a dot, then a plain name
// of at least two labels. No scheme, port, path, second star or IP address.
// The server applies the same rule (spike/lib/live-hosts.mjs), and the grant
// store refuses "*.com" and the common public suffixes after it.
function wildcardBase(raw: string): string | null {
  const text = raw.trim().toLowerCase()
  if (!text.startsWith("*.")) return null
  const base = text.slice(2).replace(/\.$/, "")
  const labels = base.split(".")
  if (labels.length < 2 || !labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null
  if (labels.every((l) => /^[0-9]+$/.test(l))) return null
  return base
}
const isWildSite = (s: Source) => s.kind === "site" && s.host.startsWith("*.")

// A website address the operator typed, as the exact origin a run will call.
// "example.com" means https; "https://app.example.com:8443/login" keeps its
// scheme, host and port and drops the path. The server checks the host again
// before it saves anything.
function siteOrigin(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null
  if (u.username || u.password) return null
  // A bare name like "intranet" is a typo more often than a target. localhost
  // and IP literals are fine: a local lab is named that way.
  if (!u.hostname.includes(".") && !labHost(u.hostname) && !u.hostname.startsWith("[")) return null
  return u.origin
}

// True for a loopback or private host: a local lab, not a public website. The
// server checks again and refuses such a host unless the operator opts in.
// A URL hostname keeps IPv6 brackets, so they are stripped first.
function labHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (h === "localhost" || h.endsWith(".localhost")) return true
  const v4 = h.match(/^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  return h === "::1" || /^f[cd]/.test(h)
}

// What POST /api/scopes gets for a list of sources: one members array, repos
// and folders mixed, in any language. The server works out the modules of a
// code scope from its content.
// Live websites go as { kind: "live", hosts, pack, permission }: `pack` is the
// list of modules the operator ticked, and the checkbox is the operator saying
// they may test the websites. The server records it as a grant.
function scopeBody(sources: Source[], name: string, modules: string[], permission: boolean, token: string, chat: { path: string; budget: string }, allowPrivate: boolean, publicNetwork: boolean): Parameters<typeof attachScope>[0] {
  const title = name || sources.map(sourceLabel).join(" + ").slice(0, 120)
  // Plain websites first: a run sends its requests to the first one, and a
  // wildcard entry is a grant pattern, not a website.
  const ordered = [...sources.filter((s) => !isWildSite(s)), ...sources.filter(isWildSite)]
  const sites = ordered.flatMap((s) => (s.kind === "site" ? [s.origin] : []))
  const bearer = token.trim()
  // garak runs only with a chat path and a budget. The server checks both.
  const chatPath = chat.path.trim()
  const assistant = chatPath || chat.budget.trim() ? { path: chatPath, budget: Number(chat.budget) } : null
  const contracts = sources.flatMap((s) => s.kind === "contract" ? [{ chainId: s.chainId, address: s.address }] : [])
  const members = sources.flatMap((s): ScopeMember[] =>
    s.kind === "site" || s.kind === "contract" ? [] : s.kind === "folder" && "path" in s ? [{ kind: "folder", name: s.name, path: s.path }] : [s],
  )
  if (sites.length) {
    const mcp = modules.includes("ai-mcp")
    return { kind: "live", title, members, contracts, hosts: sites, permission, pack: modules, networkPolicy: publicNetwork && !allowPrivate ? "public" : "strict", ...(bearer && mcp ? { token: bearer } : {}), ...(assistant && mcp ? { assistant } : {}), ...(allowPrivate ? { allowPrivate: true } : {}) }
  }
  return { title, members, contracts }
}

// A module every website scope allows, with nothing to tick. Same rule as
// alwaysOn in spike/lib/targets.mjs: it can test a live site, it sends no
// attack request, and it needs no input but the host names.
const alwaysOn = (p: PackChoice) => p.live === true && p.proof !== "http" && !p.grants
// A module the operator ticks for a website scope.
const tickable = (p: PackChoice) => p.live === true && p.proof === "http" && !p.grants

// The add row over the scope list. Closed, it is one quiet row. Open, the same
// row becomes the input in place: same height, padding, and text start, so
// nothing moves. A scope can combine code, websites and contract deployments.
// Each one added shows in a list under the row, and the scope is saved as one
// unit. Under the list: its name, then the modules it allows.
// `defaultOpen` starts with the form open (the Scopes page dialog). `onClose`
// runs whenever the form closes itself: Esc, Cancel, or a saved scope.
export function AddScope({
  packs,
  onAttached,
  onError,
  defaultOpen = false,
  onClose,
}: {
  packs: PackChoice[]
  onAttached: (scope: TargetChoice) => void
  onError: (msg: string | null) => void
  defaultOpen?: boolean
  onClose?: () => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [url, setUrl] = useState("")
  const [name, setName] = useState("")
  const [sources, setSources] = useState<Source[]>([])
  const [busy, setBusy] = useState(false)
  const [permission, setPermission] = useState(false)
  const [token, setToken] = useState("")
  const [chatPath, setChatPath] = useState("")
  const [chatBudget, setChatBudget] = useState("")
  // The modules ticked for a website scope. A run picks from them at start.
  const [modules, setModules] = useState<string[]>(["web"])
  const [allowPrivate, setAllowPrivate] = useState(false)
  const [publicNetwork, setPublicNetwork] = useState(false)
  const folderRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const live = sources.some((s) => s.kind === "site")
  // The wildcard entries widen the permission: the tick must name them.
  const wildBases = sources.flatMap((s) => (s.kind === "site" && isWildSite(s) ? [s.host.slice(2)] : []))
  // A local lab: the opt-in shows only when a listed website is loopback or private.
  const lab = sources.some((s) => s.kind === "site" && labHost(s.host))
  const choices = packs.filter(tickable)
  const included = packs.filter(alwaysOn)
  // In the server's module order, so the first ticked one is the scope's default.
  // With nothing ticked the scope still allows the always-included modules.
  const ticked = choices.filter((p) => modules.includes(p.id)).map((p) => p.id)
  const siteModules = ticked.length ? ticked : included.map((p) => p.id)
  // Only the AI/MCP module takes a caller credential. A website does not.
  const wantsToken = live && ticked.includes("ai-mcp")
  const title = (id: string, fallback: string) => packs.find((p) => p.id === id)?.title ?? fallback

  const close = () => {
    setOpen(false)
    setUrl("")
    setName("")
    setSources([])
    setModules(["web"])
    setPermission(false)
    setAllowPrivate(false)
    setPublicNetwork(false)
    setToken("")
    setChatPath("")
    setChatBudget("")
    onError(null)
    onClose?.()
  }
  const add = (s: Source) => {
    if (sources.some((x) => sourceKey(x) === sourceKey(s))) {
      onError("Already added. This entry is in the scope.")
      return false
    }
    onError(null)
    // The tick covers the websites listed when it was ticked. A new one needs a new tick.
    if (s.kind === "site") {
      setPermission(false)
      setAllowPrivate(false)
    }
    setSources((list) => [...list, s])
    return true
  }
  const addUrl = () => {
    const text = url.trim()
    if (/^(eip155:|0x)/i.test(text)) {
      const match = /^eip155:([1-9][0-9]*):(0x[0-9a-fA-F]{40})$/.exec(text)
      if (!match || !Number.isSafeInteger(Number(match[1]))) return onError("Use eip155:CHAIN_ID:ADDRESS, for example eip155:1:0x followed by 40 hex digits.")
      if (add({ kind: "contract", chainId: Number(match[1]), address: match[2].toLowerCase() })) setUrl("")
      return
    }
    const local = localPath(text)
    if (local) {
      if (add({ kind: "folder", ...local })) setUrl("")
      return
    }
    // A star is never parsed as a URL: the parser would encode it, and the
    // server would drop the entry from the grant. Keep the one accepted
    // spelling as it is, and refuse every other one with a sentence.
    if (/\*|%2a/i.test(text)) {
      // A name with letters outside plain ASCII: say the punycode form, as the server does.
      if ([...text].some((c) => c.charCodeAt(0) > 127)) {
        let ascii = ""
        try {
          ascii = text.trim().startsWith("*.") ? new URL(`http://${text.trim().slice(2)}`).hostname : ""
        } catch {
          // no ASCII form: the general hint below
        }
        return onError(`"${text}" has letters outside plain ASCII. Write the punycode form${ascii ? `: *.${ascii}` : ", for example *.xn--bcher-kva.de for *.bücher.de"}.`)
      }
      if (/^\*\.[a-z0-9-]+\.?$/i.test(text)) return onError(`"${text}" is too broad: a wildcard needs a domain name of at least two labels after "*.", so *.example.com, never *.com.`)
      const base = wildcardBase(text)
      if (!base) return onError(`"${text}" is not a wildcard entry Touchstone accepts. Write it as *.example.com: a star, a dot and a domain name, with no scheme, port or path.`)
      if (add({ kind: "site", host: `*.${base}`, origin: `*.${base}` })) setUrl("")
      return
    }
    // A user name or password in the address: say so, and never keep it.
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
      if (u.username || u.password) {
        return onError(`The address for ${u.hostname} holds a user name or password. Touchstone never keeps a credential typed into a website address. Remove it; an AI and MCP scope takes its token in the Bearer token field.`)
      }
    } catch {
      // not a URL: the checks below say so
    }
    const href = githubUrl(text) ?? (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? null : githubUrl(`https://${text}`))
    const origin = href ? null : siteOrigin(text)
    const host = origin ? new URL(origin).hostname : null
    // github.com is never a live site here: a near-miss repo URL would
    // otherwise become a permission tick for all of github.com.
    if (host === "github.com" || host?.endsWith(".github.com")) {
      return onError("Use a GitHub repository URL like https://github.com/owner/repo.")
    }
    if (!href && !origin) return onError("Use a GitHub repository URL, a website address, or a folder path like ~/project.")
    if (add(href ? { kind: "repo", url: href } : { kind: "site", host: host!, origin: origin! })) setUrl("")
  }
  // The Add button stays clickable. A click with something missing says what.
  const save = async () => {
    if (!sources.length || busy) return
    const wild = sources.find(isWildSite)
    if (wild?.kind === "site" && !sources.some((s) => s.kind === "site" && !isWildSite(s))) {
      return onError(`A wildcard entry needs a plain website too. Add ${wild.host.slice(2)} as well.`)
    }
    if (live && !permission) return onError("Tick the box to confirm you have permission to test these websites.")
    if (lab && !allowPrivate) return onError("Tick the box to confirm this is your own local lab.")
    setBusy(true)
    onError(null)
    try {
      onAttached(await attachScope(scopeBody(sources, name.trim(), siteModules, permission, token, { path: chatPath, budget: chatBudget }, lab && allowPrivate, live && !lab && publicNetwork)))
      close()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files
    if (!list?.length) return
    const read = await readFolder(list)
    e.target.value = ""
    if (typeof read === "string") return onError(read)
    if (!read.files.length) return onError(`No source files found in ${read.name}.`)
    add({ kind: "folder", name: read.name, files: read.files })
    inputRef.current?.focus()
  }

  // One row box for both states. Only its contents change.
  const row = "flex h-9 w-full items-center gap-3 rounded-lg pr-1 pl-2.5 text-left text-[13.5px] [&_svg]:size-4"

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          row,
          "mt-0.5 text-muted-foreground transition-colors outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground/15",
        )}
      >
        <Plus className="shrink-0" />
        <span className="leading-none">Add scope</span>
      </button>
    )
  }

  // One form row: a fixed label column, then the field.
  const formRow = "flex items-center gap-3 border-t border-border/60 py-1.5 pr-2 pl-2.5"
  const formLabel = "w-[72px] shrink-0 text-[11px] text-muted-foreground"
  const chip =
    "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 [&_svg]:size-3.5"
  return (
    <div className="mt-0.5 rounded-lg bg-muted/50">
      <div className={row}>
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
        </span>
        <input
          ref={inputRef}
          autoFocus
          value={url}
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation()
              close()
            }
            if (e.key === "Enter") {
              e.preventDefault()
              e.stopPropagation()
              if (url.trim()) addUrl()
              else save()
            }
          }}
          placeholder="GitHub URL, website, folder, or eip155:chainId:address"
          aria-label="GitHub URL, website, folder, or contract (eip155:chainId:address)"
          className="h-full min-w-0 flex-1 bg-transparent leading-none outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          className={chip}
          disabled={busy}
          title="Upload a folder from the browser instead. Typing its path is better: the server reads it in place."
          onClick={() => folderRef.current?.click()}
        >
          <Upload /> Upload
        </button>
        <button
          type="button"
          aria-label="Cancel"
          title="Cancel (Esc)"
          onClick={close}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
        >
          <X />
        </button>
        <input
          ref={folderRef}
          type="file"
          hidden
          onChange={onFolder}
          {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
        />
      </div>

      {sources.length ? (
        <>
          <ul className="flex flex-col border-t border-border/60 py-1" aria-label="Sources in this scope">
            {sources.map((s) => (
              <li key={sourceKey(s)} className="flex h-8 items-center gap-3 pr-1 pl-2.5 [&_svg]:size-4">
                <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                  {s.kind === "repo" ? <FolderGit2 /> : s.kind === "site" ? <Globe /> : <Folder />}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                  {s.kind === "contract" ? `eip155:${s.chainId}:${s.address}` : s.kind === "repo"
                    ? s.url.replace(/^https:\/\/github\.com\//, "")
                    : s.kind === "site"
                      ? s.origin
                      : "path" in s
                        ? s.path
                        : `${s.name}/`}
                </span>
                {isWildSite(s) ? <span className="shrink-0 text-[11px] text-muted-foreground">all subdomains</span> : null}
                {s.kind === "folder" ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    {"path" in s ? "read in place" : `${s.files.length} ${s.files.length === 1 ? "file" : "files"} uploaded`}
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-label={`Remove ${sourceLabel(s)}`}
                  title="Remove from scope"
                  disabled={busy}
                  onClick={() => {
                    if (s.kind === "site") {
                      setPermission(false)
                      setAllowPrivate(false)
                    }
                    setSources((list) => list.filter((x) => sourceKey(x) !== sourceKey(s)))
                  }}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
                >
                  <X />
                </button>
              </li>
            ))}
          </ul>
          {/* The grant covers exactly the names listed. Subdomain discovery
              needs a wildcard entry, after the plain name. Text only. */}
          {live ? (
            <p className="border-t border-border/60 py-1.5 pr-2 pl-2.5 text-[11px] leading-relaxed text-muted-foreground">
              Subdomain discovery needs a <span className="font-mono">*.</span> entry: add{" "}
              <span className="font-mono">*.example.com</span> after <span className="font-mono">example.com</span>.
            </p>
          ) : null}
          {/* Name, then modules. A ticked module shows the fields it needs under
              it. The confirmations sit last, next to the Add button. */}
          <label className={formRow}>
            <span className={formLabel}>Name</span>
            <input
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation()
                  close()
                }
                if (e.key === "Enter") {
                  e.preventDefault()
                  e.stopPropagation()
                  save()
                }
              }}
              maxLength={120}
              placeholder={sources.map(sourceLabel).join(" + ")}
              className="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </label>
          <div role="group" aria-labelledby="add-scope-modules" className={cn(formRow, "items-start py-2")}>
            <span id="add-scope-modules" className={cn(formLabel, "leading-5")}>Modules</span>
            {live ? (
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                  {choices.map((p) => (
                    <label key={p.id} className="flex h-5 cursor-pointer items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={modules.includes(p.id)}
                        disabled={busy}
                        onChange={(e) => setModules((list) => (e.target.checked ? [...list, p.id] : list.filter((id) => id !== p.id)))}
                        className="size-3.5 shrink-0 accent-foreground"
                      />
                      {p.title}
                    </label>
                  ))}
                </div>
                {included.length ? (
                  <span className="text-[11px] leading-relaxed text-muted-foreground">
                    Always included: {[...included.map((p) => p.title), ...(sources.some((s) => s.kind === "repo" || s.kind === "folder") ? [title("review", "Code review")] : []), ...(sources.some((s) => s.kind === "repo" || s.kind === "contract") ? [title("contracts", "Contracts")] : [])].join(", ")}.
                  </span>
                ) : null}
              </div>
            ) : (
              <span className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
                Set by the code. {title("review", "Code review")} always. {title("contracts", "Contracts")} too, for Solidity or a GitHub repo.
              </span>
            )}
          </div>
          {wantsToken ? (
            <label className={formRow}>
              <span className={formLabel}>Bearer token</span>
              <input
                value={token}
                disabled={busy}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Optional. The caller token an AI and MCP run tests with."
                className="h-7 min-w-0 flex-1 bg-transparent font-mono text-[11.5px] outline-none placeholder:font-sans placeholder:text-muted-foreground"
              />
            </label>
          ) : null}
          {wantsToken ? (
            <div className={formRow}>
              <span className={formLabel}>Chat path</span>
              <input
                value={chatPath}
                disabled={busy}
                onChange={(e) => setChatPath(e.target.value)}
                placeholder="Optional. The assistant's chat path, like /agent/chat."
                aria-label="Assistant chat path the prompt probe may call"
                className="h-7 min-w-0 flex-1 bg-transparent font-mono text-[11.5px] outline-none placeholder:font-sans placeholder:text-muted-foreground"
              />
              <input
                value={chatBudget}
                disabled={busy}
                inputMode="numeric"
                onChange={(e) => setChatBudget(e.target.value.replace(/\D/g, "").slice(0, 3))}
                placeholder="Requests"
                aria-label="Most requests the prompt probe may send (8 to 200)"
                className="h-7 w-20 shrink-0 bg-transparent text-right font-mono text-[11.5px] outline-none placeholder:font-sans placeholder:text-muted-foreground"
              />
            </div>
          ) : null}
          {live && !lab ? (
            <label className="flex cursor-pointer items-start gap-2.5 py-2 pr-2 pl-2.5 text-xs leading-relaxed">
              <input type="checkbox" checked={publicNetwork} disabled={busy} onChange={(e) => setPublicNetwork(e.target.checked)} className="mt-0.5 size-3.5 shrink-0 accent-foreground" />
              <span>Allow public network access<span className="block text-muted-foreground">Off by default. Lets request tools reach other public hosts, including redirects and subdomains. Private addresses stay blocked.</span></span>
            </label>
          ) : null}
          {live ? (
            <label className="flex cursor-pointer items-start gap-2.5 border-t border-border/60 py-2 pr-2 pl-2.5 text-xs leading-relaxed">
              <input
                type="checkbox"
                checked={permission}
                disabled={busy}
                onChange={(e) => {
                  setPermission(e.target.checked)
                  if (e.target.checked) onError(null)
                }}
                className="mt-0.5 size-3.5 shrink-0 accent-foreground"
              />
              <span>
                {wildBases.length
                  ? `I have permission to test these websites and every subdomain of ${wildBases.join(", ")}. A run sends real requests to them.`
                  : "I have permission to test these websites. A run sends real requests to them."}
              </span>
            </label>
          ) : null}
          {lab ? (
            <label className="flex cursor-pointer items-start gap-2.5 border-t border-border/60 py-2 pr-2 pl-2.5 text-xs leading-relaxed">
              <input
                type="checkbox"
                checked={allowPrivate}
                disabled={busy}
                onChange={(e) => {
                  setAllowPrivate(e.target.checked)
                  if (e.target.checked) onError(null)
                }}
                className="mt-0.5 size-3.5 shrink-0 accent-foreground"
              />
              <span>
                This is my own local lab. Let runs reach these loopback or private addresses. Every website in this scope must
                be localhost or a private IP.
              </span>
            </label>
          ) : null}
          <div className="flex items-center justify-end gap-3 border-t border-border/60 py-1.5 pr-1.5 pl-2.5">
            <span className="text-[11px] text-muted-foreground">
              {plural(sources.length - wildBases.length, live ? "website" : "source")}
              {wildBases.length ? ` and ${plural(wildBases.length, "subdomain entry", "subdomain entries")}` : ""}, tested as one unit
            </span>
            <Button size="sm" className="h-7 shrink-0" disabled={busy} onClick={save}>
              Add scope
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}

