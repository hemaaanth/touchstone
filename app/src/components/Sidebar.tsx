import { ThemedIcon, type ThemeIconName } from "@graphical"
import { useColorMode } from "@/lib/color-mode"
import type { ProviderInfo, SpendState } from "@/lib/types"
import { Wordmark, formatUsd } from "./bits"

// Only Activity (live runs + recorded findings) is real and wired. The rest are
// shown so the operator knows what is coming, but they open nothing — no fake
// screens, no fake data.
const COMING_PRIMARY: { icon: ThemeIconName; label: string }[] = [
  { icon: "bookOpen", label: "Playbooks" },
  { icon: "package", label: "Targets" },
]

const COMING_HARNESS: { icon: ThemeIconName; label: string }[] = [
  { icon: "globe", label: "Sandboxes" },
  { icon: "inbox", label: "Models" },
  { icon: "settings", label: "Settings" },
]

function NavRow({
  icon,
  label,
  active,
  badge,
}: {
  icon: ThemeIconName
  label: string
  active?: boolean
  badge?: string
}) {
  return (
    <div
      className={`flex h-[32px] items-center gap-(--space-s) rounded-(--radius-m) px-(--space-s) type-s ${
        active ? "weight-medium text-(--cte-text)" : "text-(--cte-text-muted)"
      }`}
      style={active ? { background: "var(--neutral-4)" } : undefined}
      aria-current={active ? "page" : undefined}
    >
      <ThemedIcon name={icon} />
      <span className="flex-1">{label}</span>
      {badge ? (
        <span className="rounded-(--radius-s) bg-(--neutral-3) px-(--space-xs) type-xxs weight-medium text-(--cte-text)">
          {badge}
        </span>
      ) : null}
    </div>
  )
}

function ComingRow({ icon, label }: { icon: ThemeIconName; label: string }) {
  return (
    <div
      className="flex h-[32px] items-center gap-(--space-s) rounded-(--radius-m) px-(--space-s) type-s text-(--cte-text-muted)"
      style={{ opacity: 0.55 }}
      aria-disabled="true"
      title="Coming — not wired yet"
    >
      <ThemedIcon name={icon} />
      <span className="flex-1">{label}</span>
      <span className="type-xxs">Soon</span>
    </div>
  )
}

export function Sidebar({
  findingCount,
  spend,
  provider,
}: {
  findingCount: number
  spend: SpendState | null
  provider: ProviderInfo | null
}) {
  const { colorMode, toggleColorMode } = useColorMode()
  const pct = spend ? Math.min(100, Math.round((spend.usd / spend.cap) * 100)) : 0
  return (
    <aside className="flex min-h-0 min-w-0 flex-col justify-between overflow-y-auto px-(--space-s) py-(--space-m)">
      <div className="flex flex-col gap-(--space-l)">
        <div className="px-(--space-s)">
          <Wordmark />
        </div>

        <nav className="flex flex-col gap-(--space-xxs)">
          <NavRow
            icon="listOrdered"
            label="Activity"
            active
            badge={findingCount ? String(findingCount) : undefined}
          />
          {COMING_PRIMARY.map((item) => (
            <ComingRow key={item.label} {...item} />
          ))}
        </nav>

        <div className="flex flex-col gap-(--space-xxs)">
          <span className="px-(--space-s) type-xxs text-(--cte-text-muted)">Harness</span>
          {COMING_HARNESS.map((item) => (
            <ComingRow key={item.label} {...item} />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-(--space-m) px-(--space-s) pb-(--space-s)">
        {spend ? (
          <div className="flex flex-col gap-(--space-xs)" title={provider ? `${provider.label} spend` : "Spend"}>
            <span className="type-xxs text-(--cte-text-muted)">Spend</span>
            <div className="flex items-center justify-between type-xxs text-(--cte-text-muted)">
              <span className="font-data tabular-nums">
                {formatUsd(spend.usd)} / {formatUsd(spend.cap)}
              </span>
            </div>
            <div className="h-[4px] w-full overflow-hidden rounded-(--radius-full) bg-(--neutral-3)">
              <span
                className="block h-full rounded-(--radius-full)"
                style={{ width: `${pct}%`, background: "var(--neutral-6)" }}
              />
            </div>
          </div>
        ) : null}
        <button
          type="button"
          onClick={toggleColorMode}
          className="focus-ring self-start rounded-(--radius-s) type-xxs text-(--cte-text-muted)"
        >
          {colorMode === "dark" ? "Light mode" : "Dark mode"}
        </button>
      </div>
    </aside>
  )
}
