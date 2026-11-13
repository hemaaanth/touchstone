"use client";

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  ClockIcon,
  Loader2Icon,
  ShieldCheckIcon,
  ShieldIcon,
  ShieldMinusIcon,
  ShieldXIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { INK, severityTone } from "@/lib/format";
import type { Severity } from "@/lib/types";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// Small marks that replace a second status word. Each one is an icon with a
// tooltip and an accessible name, so a row needs at most one text label.
// Colour follows docs/restraint.md: everything is neutral until a replay
// proved the finding. Only then does severity take its colour.

/**
 * A tooltip on a non-interactive mark. The name is read by screen readers.
 * Keyboard users reach the tip too. A mark that stands alone is a tab stop.
 * A mark inside a row that is a button or a link is not, since a control may
 * not hold another one: its tip opens while the row has keyboard focus.
 */
export function Hint({
  label,
  tip,
  children,
  className,
}: {
  /** The accessible name, e.g. "High severity". */
  label: string;
  /** The tooltip text. Defaults to the label. */
  tip?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [rowFocus, setRowFocus] = useState(false);
  // A row can turn from disabled to enabled, so this checks on every render.
  useEffect(() => {
    const el = ref.current;
    const row = el?.parentElement?.closest<HTMLElement>("button:enabled, a[href], [role=button]");
    if (el) el.tabIndex = row ? -1 : 0;
    if (!row) return;
    const on = () => setRowFocus(row.matches(":focus-visible"));
    const off = () => setRowFocus(false);
    row.addEventListener("focus", on);
    row.addEventListener("blur", off);
    return () => {
      row.removeEventListener("focus", on);
      row.removeEventListener("blur", off);
    };
  });
  const trigger: ReactElement = (
    <span
      ref={ref}
      role="img"
      tabIndex={0}
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    />
  );
  return (
    <TooltipProvider delay={300}>
      <Tooltip open={open || rowFocus} onOpenChange={setOpen}>
        <TooltipTrigger render={trigger}>{children}</TooltipTrigger>
        <TooltipContent>{tip ?? label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const LEVEL: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

const severityWord = (s: string) => {
  const t = s.trim().toLowerCase();
  return t ? `${t[0].toUpperCase()}${t.slice(1)} severity` : "Unrated severity";
};

/**
 * Severity as four rising bars, filled to the level. The bars are neutral
 * until the finding is proven. Then they take the severity colour.
 */
export function SeverityMark({
  severity,
  proven = false,
  className,
}: {
  severity: Severity | string | null | undefined;
  proven?: boolean;
  className?: string;
}) {
  const sev = (severity ?? "").toLowerCase();
  const level = LEVEL[sev] ?? 0;
  const fill = proven && sev in LEVEL ? INK[severityTone(sev as Severity)] : "text-foreground/55";
  const word = severityWord(sev);
  return (
    <Hint label={word} tip={proven ? word : `${word} · not proven`} className={className}>
      <span aria-hidden className="flex h-3 items-end gap-[2px]">
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={cn(
              "w-[3px] rounded-[1px] bg-current",
              i <= level ? fill : "text-foreground/15",
            )}
            style={{ height: `${3 + i * 2.25}px` }}
          />
        ))}
      </span>
    </Hint>
  );
}

export type ProofState = "waiting" | "replaying" | "proven" | "unproven" | "dropped" | "lead";

const PROOF: Record<ProofState, { word: string; Icon: typeof ShieldIcon; ink: string; spin?: boolean }> = {
  lead: { word: "Lead, not proven", Icon: ShieldIcon, ink: "text-muted-foreground" },
  waiting: { word: "Waiting for the final replay", Icon: ClockIcon, ink: "text-muted-foreground" },
  replaying: { word: "Replaying", Icon: Loader2Icon, ink: "text-muted-foreground", spin: true },
  proven: { word: "Proven by replay", Icon: ShieldCheckIcon, ink: "text-ok" },
  unproven: { word: "Not reproduced", Icon: ShieldXIcon, ink: "text-muted-foreground" },
  dropped: { word: "Not recorded", Icon: ShieldMinusIcon, ink: "text-muted-foreground" },
};

/** The bare proof icon, for a mark that already sits inside a Hint. */
export function ProofIcon({ state, className }: { state: ProofState; className?: string }) {
  const p = PROOF[state];
  return (
    <p.Icon
      aria-hidden
      className={cn("size-3.5", p.ink, p.spin && "animate-spin motion-reduce:animate-none", className)}
    />
  );
}

/** Proof state as one icon. Only a proven finding is green. */
export function ProofMark({
  state,
  tip,
  className,
}: {
  state: ProofState;
  /** A longer tooltip. The accessible name stays the short word. */
  tip?: ReactNode;
  className?: string;
}) {
  const word = PROOF[state].word;
  return (
    <Hint label={word} tip={tip ?? word} className={className}>
      <ProofIcon state={state} />
    </Hint>
  );
}
