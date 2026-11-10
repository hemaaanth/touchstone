"use client";

import type { ComponentProps, ReactNode } from "react";
import { CheckIcon, PauseIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { mono, paper } from "./surfaces";

export type AgentState = "working" | "waiting" | "done" | "failed";

export interface StatusStep {
  state: AgentState;
  label: string;
}

export function AgentStatus({
  state,
  label,
  elapsed,
  trailing,
  className,
  ...props
}: Omit<ComponentProps<"span">, "children" | "state" | "label" | "elapsed"> & {
  state: AgentState;
  label: string;
  elapsed?: string | undefined;
  trailing?: ReactNode | undefined;
}) {
  return (
    <span
      data-slot="agent-status"
      className={cn(
        paper,
        "flex items-center gap-2.5 rounded-full py-1.5 ps-3.5 pe-1.5",
        className,
      )}
      {...props}
    >
      {state === "done" ? (
        <CheckIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      ) : state === "failed" ? (
        <XIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full motion-reduce:animate-none",
            state === "working"
              ? "animate-pulse bg-blue-500 dark:bg-blue-400"
              : "border-foreground/35 border",
          )}
        />
      )}
      <span className="sr-only">{state}</span>
      {/* The pill is centered by its parent, so any width change jumps it. The
          label reserves the width of the longest activity word ("Thinking") and
          stays left-aligned, so swapping Thinking/Working/Writing/Idle never
          shifts the pill. */}
      <span
        key={label}
        className="fade-in blur-in-[2px] animate-in inline-block min-w-[3.75rem] max-w-44 truncate text-start text-xs duration-300 motion-reduce:animate-none"
      >
        {label}
      </span>
      {elapsed !== undefined && state !== "done" && state !== "failed" && (
        // tabular-nums keeps the digits from dancing; the reserved width keeps a
        // minute rollover (0:59 → 1:00 → 10:00) from nudging the pill.
        <span
          className={cn(
            mono,
            "inline-block min-w-[2.75rem] text-end text-muted-foreground tabular-nums",
          )}
        >
          {elapsed}
        </span>
      )}
      <span
        aria-hidden
        data-slot="agent-status-trailing"
        className="text-muted-foreground flex size-6 items-center justify-center rounded-full"
      >
        {trailing !== undefined ? (
          trailing
        ) : state === "done" || state === "failed" ? (
          <RotateCcwIcon className="size-3" />
        ) : (
          <PauseIcon className="size-3" />
        )}
      </span>
    </span>
  );
}
