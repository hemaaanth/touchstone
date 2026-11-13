import { cn } from "cn"
import {
  Activity,
  Bot,
  Box,
  Cloud,
  Fish,
  Globe,
  KeyRound,
  LogIn,
  Package,
  Radar,
  ScrollText,
  SearchCode,
  type LucideIcon,
} from "lucide-react"
import { moduleStyle, orderModules } from "@/lib/module-colors"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

// The one way the console shows a module (pack): a pill in the module's own
// colour. The colour comes from src/lib/module-colors.ts, so it is the same on
// every screen. Use `compact` in a dense row. Pass `label` (the pack title);
// without it the pill shows the id.
//
//   <ModulePill id="web" label="Web and sign-in" />
//   <ModulePills ids={scope.packs} packs={packs} compact max={3} />

const MODULE_ICON: Record<string, LucideIcon> = {
  "contracts": ScrollText,
  "review": SearchCode,
  "supply-chain": Package,
  "web": LogIn,
  "domains": Globe,
  "ai-mcp": Bot,
  "surface": Radar,
  "phishing": Fish,
  "chain-watch": Activity,
  "infra-cloud": Cloud,
  "keys": KeyRound,
}

// The module's icon alone. A module the map does not know gets a plain box,
// like its neutral colour. Add `text-(--module)` with `style={moduleStyle(id)}`
// (src/lib/module-colors.ts) to tint it.
export function ModuleIcon({ id, className }: { id: string; className?: string }) {
  const Icon = Object.hasOwn(MODULE_ICON, id) ? MODULE_ICON[id] : Box
  return <Icon aria-hidden className={className} />
}

const PILL = "inline-flex max-w-full min-w-0 shrink-0 items-center rounded-full font-medium whitespace-nowrap"
const SIZE = {
  default: "h-[22px] gap-1.5 px-2 text-xs [&>svg]:size-3",
  compact: "h-[18px] gap-1 px-1.5 text-[11px] [&>svg]:size-[11px]",
}

export function ModulePill({
  id,
  label,
  icon = true,
  compact = false,
  className,
}: {
  id: string
  // The pack title. Falls back to the id.
  label?: string
  // Show the module's icon. Default on.
  icon?: boolean
  // The small size, for a dense row.
  compact?: boolean
  className?: string
}) {
  return (
    <span
      data-slot="module-pill"
      data-module={id}
      style={moduleStyle(id)}
      className={cn(PILL, SIZE[compact ? "compact" : "default"], "bg-(--module)/10 text-(--module) dark:bg-(--module)/14", className)}
    >
      {icon && <ModuleIcon id={id} className="shrink-0" />}
      <span className="truncate">{label ?? id}</span>
    </span>
  )
}

// A scope's or a run's modules as pills. `max` keeps a row short: the rest
// fold into a "+N" pill that names them in a tooltip. With `packs`, the pills
// take the order of the server's module list, the same on every row.
export function ModulePills({
  ids,
  packs,
  compact = false,
  icon = true,
  max,
  className,
}: {
  ids: string[]
  packs?: { id: string; title: string }[]
  compact?: boolean
  icon?: boolean
  max?: number
  className?: string
}) {
  const title = (id: string) => packs?.find((p) => p.id === id)?.title ?? id
  const all = packs ? orderModules(ids, packs.map((p) => p.id)) : ids
  const shown = max != null && all.length > max ? all.slice(0, max) : all
  const rest = all.slice(shown.length)
  if (ids.length === 0) return null
  return (
    <span data-slot="module-pills" className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
      {shown.map((id) => (
        <ModulePill key={id} id={id} label={title(id)} compact={compact} icon={icon} />
      ))}
      {rest.length > 0 && (
        <Tooltip>
          <TooltipTrigger
            render={<span tabIndex={0} />}
            aria-label={`${rest.length} more: ${rest.map(title).join(", ")}`}
            className={cn(PILL, SIZE[compact ? "compact" : "default"], "bg-muted text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50")}
          >
            +{rest.length}
          </TooltipTrigger>
          <TooltipContent>{rest.map(title).join(", ")}</TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}
