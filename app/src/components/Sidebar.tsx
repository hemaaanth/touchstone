import { Select, ThemedIcon, type ThemeIconName } from "@graphical"
import { useColorMode } from "@/lib/color-mode"
import type { ProviderInfo, SpendState, TargetChoice } from "@/lib/types"
import { Fold, Wordmark, formatUsd } from "./bits"

// Inventory, not routes. Keep unfinished destinations folded and inert.
const COMING: { icon: ThemeIconName; label: string }[] = [
  { icon: "bookOpen", label: "Playbooks" },
  { icon: "package", label: "Targets" },
  { icon: "globe", label: "Sandboxes" },
  { icon: "inbox", label: "Models" },
  { icon: "settings", label: "Settings" },
]

export function Sidebar({ findingCount, spend, provider, targets, scopeId, onScopeChange }: {
  findingCount: number
  spend: SpendState | null
  provider: ProviderInfo | null
  targets: TargetChoice[]
  scopeId: string
  onScopeChange: (id: string) => void
}) {
  const { colorMode, toggleColorMode } = useColorMode()
  const pct = spend ? Math.min(100, Math.round((spend.usd / spend.cap) * 100)) : 0
  const scope = targets.find((t) => t.id === scopeId)
  const options = [
    { value: "__random__", label: "Random scope" },
    ...targets.map((t) => ({ value: t.id, label: t.title })),
  ]
  return (
    <aside aria-label="Console navigation" className="flex min-h-0 min-w-0 flex-col justify-between overflow-y-auto px-(--space-s) py-(--space-m)">
      <div className="flex flex-col gap-(--space-xl)">
        <div className="px-(--space-s)"><Wordmark /></div>

        <section aria-label="Next run scope" className="flex min-w-0 flex-col gap-(--space-s) px-(--space-s)">
          <Select.Root items={options} value={scopeId || "__random__"} onValueChange={(value) => onScopeChange(value === "__random__" ? "" : String(value))}>
            <Select.Label>Next run scope</Select.Label>
            <Select.Trigger className="focus-ring w-full min-w-0">
              <Select.Value className="min-w-0 truncate" />
              <Select.Icon />
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {options.map((item) => (
                      <Select.Item key={item.value} value={item.value}>
                        <Select.ItemText>{item.label}</Select.ItemText>
                        <Select.ItemIndicator />
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
          <p className="type-xs text-(--cte-text-muted)">{scope ? <span className="font-data break-all">{scope.entry}</span> : "A target is picked at random for each run."}</p>
          {scope ? <Fold label="Scope details"><p className="type-xs text-(--cte-text-muted)">{scope.blurb}</p></Fold> : null}
        </section>

        <nav aria-label="Workspace">
          <div aria-current="page" className="flex items-center gap-(--space-s) rounded-(--radius-m) bg-(--neutral-4) p-(--space-s) type-s weight-medium text-(--cte-text)">
            <ThemedIcon name="listOrdered" />
            <span className="flex-1">Activity</span>
            {findingCount ? <span className="type-xxs" title="Counted findings">{findingCount}</span> : null}
          </div>
          <p className="px-(--space-s) pt-(--space-xs) type-xxs text-(--cte-text-muted)">All scopes · runs & findings</p>
        </nav>

        <div className="px-(--space-s)">
          <Fold label="Coming soon">
            <div className="flex flex-col gap-(--space-m)">
              {COMING.map(({ icon, label }) => (
                <div key={label} aria-disabled="true" className="flex items-center gap-(--space-s) type-xs text-(--cte-text-muted)">
                  <ThemedIcon name={icon} /><span>{label}</span>
                </div>
              ))}
            </div>
          </Fold>
        </div>
      </div>

      <div className="flex flex-col gap-(--space-m) px-(--space-s) pt-(--space-xl) pb-(--space-s)">
        {spend ? (
          <div className="flex flex-col gap-(--space-xs)" title={provider ? `${provider.label} spend` : "Spend"}>
            <span className="type-xxs text-(--cte-text-muted)">Spend</span>
            <span className="font-data tabular-nums type-xxs text-(--cte-text-muted)">{formatUsd(spend.usd)} / {formatUsd(spend.cap)}</span>
            <div className="h-[4px] w-full overflow-hidden rounded-(--radius-full) bg-(--neutral-3)">
              <span className="block h-full rounded-(--radius-full) bg-(--neutral-6)" style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : null}
        <button type="button" onClick={toggleColorMode} className="focus-ring self-start rounded-(--radius-s) type-xxs text-(--cte-text-muted)">
          {colorMode === "dark" ? "Light mode" : "Dark mode"}
        </button>
      </div>
    </aside>
  )
}
