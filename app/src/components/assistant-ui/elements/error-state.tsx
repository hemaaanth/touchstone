"use client";

import type { ReactNode } from "react";
import { Loader2Icon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { card } from "./surfaces";

// assistant-ui's error-state element in our theme. One alert: an icon, a title,
// one muted line of detail, and the next step. The icon is amber, not red: red
// stays for a proven finding and destructive controls (docs/restraint.md).
//
// Retrying never changes the layout. The button keeps its label and width; only
// its icon turns into a spinner. The card fades in, so it never flashes.
//
// `compact` is one line for a reserved slot, such as the composer's action row.
// The full text stays in the tooltip.

export function ErrorState({
  title,
  detail,
  icon: Icon = TriangleAlertIcon,
  retrying = false,
  onRetry,
  retryLabel = "Retry",
  actions,
  children,
  compact = false,
  className,
}: {
  title: string;
  detail?: ReactNode;
  icon?: typeof TriangleAlertIcon;
  retrying?: boolean;
  onRetry?: () => void;
  retryLabel?: string;
  /** More controls beside Retry, e.g. a "Technical details" trigger. */
  actions?: ReactNode;
  /** Shown under the actions, e.g. the technical details panel. */
  children?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  if (compact) {
    const full = typeof detail === "string" ? `${title}. ${detail}` : title;
    return (
      <span
        data-slot="error-state"
        role="alert"
        title={full}
        className={cn(
          "flex min-w-0 items-center gap-1.5 px-1.5 text-xs animate-in fade-in duration-200 motion-reduce:animate-none",
          className,
        )}
      >
        <Icon aria-hidden className="size-3.5 shrink-0 text-warn" />
        <span className="shrink-0 font-medium text-foreground">{title}</span>
        {detail ? <span className="min-w-0 truncate text-muted-foreground">{detail}</span> : null}
      </span>
    );
  }

  return (
    <div
      data-slot="error-state"
      role="alert"
      className={cn(
        card,
        "flex gap-3 px-4 py-3.5 animate-in fade-in duration-300 motion-reduce:animate-none",
        className,
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {detail ? <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{detail}</p> : null}
        {onRetry || actions ? (
          <div className="mt-3 flex items-center gap-3">
            {onRetry ? (
              <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying} aria-busy={retrying}>
                {retrying ? (
                  <Loader2Icon aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <RefreshCwIcon aria-hidden className="size-3.5" />
                )}
                {retryLabel}
              </Button>
            ) : null}
            {actions}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
