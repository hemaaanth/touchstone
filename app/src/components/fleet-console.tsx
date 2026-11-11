import { useEffect, useRef, useState } from "react"
import { Boxes, FileText, FolderGit2, MessageSquare, Network } from "lucide-react"
import { FIXTURES, coordinatorAgent } from "@/lib/fleet-fixtures"
import { cn } from "@/lib/utils"
import { PageHeader } from "@/components/page-parts"
import { FleetPanel } from "@/components/fleet-panel"
import { BulletinFeed } from "@/components/bulletin-feed"
import { ScrollArea } from "@/components/ui/scroll-area"

// The operator console — the continuous canvas from docs §6b. One workspace,
// not a grid of rounded cards:
//   center dock = Conversation | Bulletin
//   right dock  = Files | Fleet
// On a wide (≥1680px) desktop, Files and Fleet pin side by side; at 1440px the
// right dock is a single tabbed column so we never force four narrow columns.
// Dock views toggle via `hidden`, not unmount, so selection and scroll survive
// a switch.
//
// A fixture selector stands in for the live coordinator (a sibling track). Every
// pane takes a Fleet + Lead[]; swapping the fixture for live data is one prop.

function useWide() {
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1680px)")
    const onChange = () => setWide(mql.matches)
    onChange()
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])
  return wide
}

type CenterView = "conversation" | "bulletin"
type RightView = "files" | "fleet"

export function FleetConsole() {
  const [fixtureKey, setFixtureKey] = useState(FIXTURES[1].key)
  const fixture = FIXTURES.find((f) => f.key === fixtureKey) ?? FIXTURES[0]
  const [center, setCenter] = useState<CenterView>("bulletin")
  const [right, setRight] = useState<RightView>("fleet")
  // Fleet selection is held here so it survives a dock-view switch. Reset on a
  // fixture change, since that is a different run.
  const [selected, setSelected] = useState<string | null>(null)
  const prevFixture = useRef(fixtureKey)
  if (prevFixture.current !== fixtureKey) {
    prevFixture.current = fixtureKey
    if (selected !== null) setSelected(null)
  }

  const wide = useWide()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader icon={Network} title="Operator console">
        <div className="flex items-center gap-1 rounded-md border p-0.5" data-testid="fixture-selector">
          {FIXTURES.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFixtureKey(f.key)}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                f.key === fixtureKey ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </PageHeader>

      <p className="border-b bg-muted/30 px-5 py-1.5 text-[11px] text-muted-foreground">{fixture.note}</p>

      <div className="flex min-h-0 flex-1">
        {/* Center dock: Conversation | Bulletin */}
        <section className="flex min-w-0 flex-1 flex-col border-r">
          <DockTabs
            value={center}
            onChange={(v) => setCenter(v as CenterView)}
            tabs={[
              { id: "conversation", label: "Conversation", icon: MessageSquare },
              { id: "bulletin", label: "Bulletin", icon: Boxes },
            ]}
          />
          <div className="relative min-h-0 flex-1">
            <Pane show={center === "conversation"}>
              <ConversationPane />
            </Pane>
            <Pane show={center === "bulletin"}>
              <BulletinFeed fleet={fixture.fleet} leads={fixture.leads} />
            </Pane>
          </div>
        </section>

        {/* Right dock: Files | Fleet. Side by side when wide, else tabbed. */}
        {wide ? (
          <section className="flex w-[680px] shrink-0">
            <div className="flex w-[300px] shrink-0 flex-col border-r">
              <DockLabel icon={FileText} label="Files" />
              <FilesPane />
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <DockLabel icon={FolderGit2} label="Fleet" />
              <FleetPanel fleet={fixture.fleet} leads={fixture.leads} selectedId={selected} onSelect={setSelected} />
            </div>
          </section>
        ) : (
          <section className="flex w-[400px] shrink-0 flex-col">
            <DockTabs
              value={right}
              onChange={(v) => setRight(v as RightView)}
              tabs={[
                { id: "files", label: "Files", icon: FileText },
                { id: "fleet", label: "Fleet", icon: FolderGit2 },
              ]}
            />
            <div className="relative min-h-0 flex-1">
              <Pane show={right === "files"}>
                <FilesPane />
              </Pane>
              <Pane show={right === "fleet"}>
                <FleetPanel fleet={fixture.fleet} leads={fixture.leads} selectedId={selected} onSelect={setSelected} />
              </Pane>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

// A line tab strip for a dock. Reuses the house line-tab look (underline on the
// active tab), not a new control.
function DockTabs({
  value,
  onChange,
  tabs,
}: {
  value: string
  onChange: (v: string) => void
  tabs: { id: string; label: string; icon: typeof Boxes }[]
}) {
  return (
    <div className="flex items-center gap-1 border-b px-2">
      {tabs.map((t) => {
        const Icon = t.icon
        const active = t.id === value
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={cn(
              "relative flex items-center gap-1.5 px-2 py-2 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {t.label}
            {active ? <span className="absolute inset-x-1 -bottom-px h-0.5 bg-foreground" /> : null}
          </button>
        )
      })}
    </div>
  )
}

// A static label for a pinned (non-tabbed) dock pane in the wide layout.
function DockLabel({ icon: Icon, label }: { icon: typeof Boxes; label: string }) {
  return (
    <div className="flex items-center gap-1.5 border-b px-3 py-2">
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="text-xs font-medium">{label}</span>
    </div>
  )
}

// Keeps an inactive dock pane mounted (so its scroll + selection survive a
// switch) but visually hidden.
function Pane({ show, children }: { show: boolean; children: React.ReactNode }) {
  return <div className={cn("absolute inset-0 flex min-h-0 flex-col", !show && "hidden")}>{children}</div>
}

// A read-only mock of the coordinator conversation. The operator talks ONLY to
// the coordinator here; the composer reads "Message coordinator." and the
// children are never addressable from this surface.
function ConversationPane() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <div className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">C</div>
        <div className="flex flex-col">
          <span className="text-xs font-medium">{coordinatorAgent.name}</span>
          <span className="font-mono text-[10px] text-muted-foreground">{coordinatorAgent.model}</span>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-4 py-4 text-sm">
          <Bubble who="operator">Run the staking and dex modules. Scale as you need.</Bubble>
          <Bubble who="coordinator">
            Spawned six hunters across defi-dex, defi-staking, defi-lending, and oracle-price, plus one quarantined
            attacker worker. Watching the bulletin and routing proposed leads to the oracle.
          </Bubble>
          <Bubble who="coordinator">
            Recon-Alpha's allowance lead is corroborated and now verifying. The attacker worker posted a raw-tx to the
            evidence lane — it stays quarantined until the replay proves it.
          </Bubble>
        </div>
      </ScrollArea>
      <div className="border-t p-3">
        <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Message coordinator.
          <span className="ml-auto text-[10px] text-muted-foreground/60">read-only mock</span>
        </div>
      </div>
    </div>
  )
}

function Bubble({ who, children }: { who: "operator" | "coordinator"; children: React.ReactNode }) {
  const op = who === "operator"
  return (
    <div className={cn("flex", op && "justify-end")}>
      <div
        className={cn(
          "max-w-[82%] rounded-lg px-3 py-2 leading-relaxed",
          op ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
        )}
      >
        {children}
      </div>
    </div>
  )
}

// A static mock file tree, enough to show the Files dock in the canvas.
const FILES = [
  "run-7f3a/",
  "  plan.md",
  "  defi-dex/recon.json",
  "  defi-staking/exploit.sol",
  "  defi-staking/raw-tx.hex",
  "  oracle-price/mechanism.md",
  "  evidence/0x7ad9…c1.tx",
]
function FilesPane() {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <ul className="px-3 py-2">
        {FILES.map((f) => (
          <li key={f} className="whitespace-pre py-0.5 font-mono text-[11px] text-muted-foreground">
            {f}
          </li>
        ))}
      </ul>
    </ScrollArea>
  )
}
