// Class names the list parts share (page-parts.tsx), apart from the components
// so a component file exports only components (fast refresh).
import { cn } from "@/lib/utils"

// The card a list sits in. ListCard and ListLoading use it, and so does a list
// that builds its own rows (the Findings loading rows).
export const LIST_CARD_CLASS = "overflow-hidden rounded-xl border bg-card"

// The look every list row shares: padding, the rounded first and last row, the
// open row, and hover and focus when the row opens something. ListRow uses it,
// and so does a row with its own column layout (the Findings list).
export function rowClass(opens: boolean) {
  return cn(
    "px-4 py-3 transition-colors first:rounded-t-[calc(var(--radius-xl)-1px)] last:rounded-b-[calc(var(--radius-xl)-1px)] data-active:bg-muted/50",
    opens && "cursor-pointer hover:bg-muted/50 has-[[data-row-main]:focus-visible]:bg-muted/50 has-[[data-row-main]:focus-visible]:ring-2 has-[[data-row-main]:focus-visible]:ring-ring/50 has-[[data-row-main]:focus-visible]:ring-inset",
  )
}
