import { FolderGit2, Boxes, BookMarked, Settings2 } from "lucide-react"

type PageId = "projects" | "modules" | "playbooks" | "settings"

const META: Record<PageId, { icon: typeof FolderGit2; label: string; blurb: string }> = {
  projects: {
    icon: FolderGit2,
    label: "Projects",
    blurb: "The Solidity codebases in scope. Each project is a checkout the agent attacks inside a sandbox.",
  },
  modules: {
    icon: Boxes,
    label: "Modules",
    blurb: "Attack modules the agent can run: static leads, fuzz accounting, PoC synthesis, replay proof.",
  },
  playbooks: {
    icon: BookMarked,
    label: "Playbooks",
    blurb: "Saved run recipes — a scope plus a module plan — so a proven attack path is one click to repeat.",
  },
  settings: {
    icon: Settings2,
    label: "Settings",
    blurb: "Provider, spend cap, and the no-live-harm guardrails every run inherits.",
  },
}

// Placeholder surface for the single-item nav pages. These are stubs until the
// matching backend lands; they keep the shell navigable and name what each page
// will hold without pretending to show data we have not proven.
export function PageStub({ id }: { id: PageId }) {
  const meta = META[id]
  const Icon = meta.icon
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-5 py-3">
        <Icon className="size-4" />
        <h1 className="text-sm font-semibold">{meta.label}</h1>
      </header>
      <div className="grid flex-1 place-items-center p-8">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="flex size-10 items-center justify-center rounded-xl border bg-muted/40">
            <Icon className="size-5 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">{meta.blurb}</p>
          <p className="text-xs text-muted-foreground/70">Coming soon.</p>
        </div>
      </div>
    </div>
  )
}
