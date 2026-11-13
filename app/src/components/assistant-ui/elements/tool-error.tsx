"use client";

import type { ReactNode } from "react";
import { Loader2Icon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { mono } from "./surfaces";

// assistant-ui's tool-error element in our theme: one row for a tool or an
// agent that stopped with an error. The name, what it was working on, the
// message in sentence case, and two quiet actions. Amber, never red: a failed
// step is normal work, not a finding (docs/restraint.md).
//
// While a retry is in flight the row keeps its shape. The Retry button keeps
// its label and width; only its icon turns into a spinner.

const quiet =
  "inline-flex items-center gap-1.5 rounded-md border border-foreground/15 bg-background px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50";

export function ToolError({
  name,
  target,
  message,
  attempt,
  maxAttempts,
  retrying = false,
  disabled = false,
  onRetry,
  onSkip,
  retryLabel = "Retry",
  skipLabel = "Skip",
  onName,
  children,
  className,
  ...props
}: {
  /** The tool or agent name. */
  name: ReactNode;
  /** What it was working on. */
  target?: ReactNode;
  /** The error, already in sentence case. */
  message: ReactNode;
  attempt?: number;
  maxAttempts?: number;
  retrying?: boolean;
  disabled?: boolean;
  onRetry?: () => void;
  onSkip?: () => void;
  retryLabel?: string;
  skipLabel?: string;
  /** Makes the name a link, e.g. to open the agent's thread. */
  onName?: () => void;
  /** More under the message, e.g. a fold with the raw output. */
  children?: ReactNode;
  className?: string;
  "data-step-key"?: string;
}) {
  const off = disabled || retrying;
  return (
    <div
      data-slot="tool-error"
      role="alert"
      className={cn(
        "flex max-w-160 items-start gap-2.5 rounded-[10px] border bg-background px-3 py-2.5 animate-in fade-in duration-200 motion-reduce:animate-none",
        className,
      )}
      {...props}
    >
      <TriangleAlertIcon aria-hidden className="mt-[3px] size-3.5 shrink-0 text-warn" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          {onName ? (
            <button
              type="button"
              onClick={onName}
              className="shrink-0 rounded-sm text-[13px] font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-foreground/15"
            >
              {name}
            </button>
          ) : (
            <span className="shrink-0 text-[13px] font-medium">{name}</span>
          )}
          {target ? <span className="min-w-0 truncate text-xs text-muted-foreground">{target}</span> : null}
          {attempt && maxAttempts ? (
            <span className={cn(mono, "ml-auto shrink-0 text-muted-foreground tabular-nums")}>
              {attempt}/{maxAttempts}
            </span>
          ) : null}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground break-words">{message}</p>
        {children}
      </div>
      {onRetry || onSkip ? (
        <div className="flex shrink-0 items-center gap-1.5 self-center">
          {onRetry ? (
            <button type="button" className={quiet} disabled={off} onClick={onRetry} aria-busy={retrying}>
              {retrying ? (
                <Loader2Icon aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />
              ) : (
                <RefreshCwIcon aria-hidden className="size-3" />
              )}
              {retryLabel}
            </button>
          ) : null}
          {onSkip ? (
            <button type="button" className={quiet} disabled={off} onClick={onSkip}>
              {skipLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
