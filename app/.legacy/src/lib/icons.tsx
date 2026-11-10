import type { ThemeIconName, ThemeIconRenderProps } from "@graphical"
import {
  Archive,
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  Award,
  Bell,
  Bold,
  BookOpen,
  Bookmark,
  CalendarDays,
  CalendarPlus,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  CreditCard,
  Download,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  Gift,
  Globe,
  House,
  Inbox,
  Info,
  Italic,
  ListOrdered,
  LoaderCircle,
  Mailbox,
  MapPin,
  Minus,
  Package,
  PanelLeft,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plus,
  Printer,
  Redo2,
  Save,
  Search,
  Settings,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  Stamp,
  Tag,
  Timer,
  Trash2,
  TrendingUp,
  Truck,
  Underline,
  Undo2,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react"

/** The theme's icon names, drawn with the installed Lucide pack (outlined). */
const LUCIDE: Record<ThemeIconName, LucideIcon> = {
  home: House,
  folder: Folder,
  team: UsersRound,
  settings: Settings,
  inboxTray: Inbox,
  shoppingBag: ShoppingBag,
  gift: Gift,
  creditCard: CreditCard,
  award: Award,
  pause: Pause,
  play: Play,
  bookmark: Bookmark,
  arrowRight: ArrowRight,
  archive: Archive,
  inbox: ArrowDownToLine,
  adjust: SlidersHorizontal,
  document: FileText,
  search: Search,
  paperclip: Paperclip,
  bell: Bell,
  trash: Trash2,
  stamp: Stamp,
  globe: Globe,
  pencil: Pencil,
  mailbox: Mailbox,
  panelLeft: PanelLeft,
  check: Check,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  minus: Minus,
  plus: Plus,
  close: X,
  info: Info,
  bold: Bold,
  italic: Italic,
  underline: Underline,
  copy: Copy,
  download: Download,
  filePlus: FilePlus,
  folderOpen: FolderOpen,
  printer: Printer,
  save: Save,
  undo: Undo2,
  redo: Redo2,
  arrowUp: ArrowUp,
  calendarPlus: CalendarPlus,
  calendarDays: CalendarDays,
  mapPin: MapPin,
  tag: Tag,
  package: Package,
  truck: Truck,
  listOrdered: ListOrdered,
  loader: LoaderCircle,
  timer: Timer,
  bookOpen: BookOpen,
  checkCheck: CheckCheck,
  shieldCheck: ShieldCheck,
  trendingUp: TrendingUp,
}

/**
 * Renderer for IconRendererProvider. It forwards every SVG prop, including
 * style, so the theme's size, weight and accessibility props survive.
 * Filled requests return undefined so the library draws its own filled art.
 */
export function renderThemeIcon({
  name,
  family,
  variant,
  weight: _weight,
  hugeiconsVariant: _hugeiconsVariant,
  ...svgProps
}: ThemeIconRenderProps) {
  if (family !== "Lucide" || variant !== "outlined") return undefined
  const Icon = LUCIDE[name]
  if (!Icon) return undefined
  const { style, ...rest } = svgProps as Omit<typeof svgProps, "ref">
  // Button spec: inline control icons are 1em square and do not shrink.
  // Explicit width, height or size from the library still win.
  return (
    <Icon
      size="1em"
      strokeWidth="var(--icon-stroke-width, 2)"
      data-icon-family="Lucide"
      data-icon-style="outlined"
      style={{ flexShrink: 0, ...style }}
      {...rest}
    />
  )
}
