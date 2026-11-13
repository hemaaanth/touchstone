"use client";

import { useState, type ReactNode } from "react";
import { CheckIcon, ChevronRightIcon, Loader2Icon, MinusIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { card, mono, ShimmerLabel, StatusMark, type Mark } from "./surfaces";

// The run's setup, from "starting" to the first agent step, as one card. It
// has the same shape as the ToolGroup card that follows it: the same header,
// chevron, row style and width. So the thread never changes container kind,
// indent or width while the run gets ready. Rows only grow: the last row
// changes its words in place ("Starting the agent session" becomes "Agent
// session started"). A live run and a replayed run build the same card.
//
// Closed by default (docs/restraint.md). A run that stopped before the agent
// started opens it, because the card is all there is to read. Neutral
// throughout: a failed tool is a coverage gap, not a finding.

export interface RunStartRow {
  key: string;
  label: string;
  detail?: string;
  mark: Mark;
  word?: string;
}

const ROW_ICON: Partial<Record<Mark, typeof CheckIcon>> = {
  running: Loader2Icon,
  fail: XIcon,
  off: MinusIcon,
};

export function RunStart({
  rows,
  meta,
  mark,
  word,
  active,
  openFirst,
  children,
  className,
}: {
  rows: readonly RunStartRow[];
  meta: string | null;
  mark: Mark;
  word?: string;
  active: boolean;
  openFirst: boolean;
  /** More detail under the rows, e.g. the tool scan's leads. */
  children?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(openFirst);
  return (
    <div
      data-slot="run-start"
      className={cn(card, "flex w-full flex-col overflow-hidden", className)}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2.5 px-3.5 py-2.5 text-start transition-colors hover:bg-foreground/[0.03]"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <ShimmerLabel active={active} className="min-w-0 truncate text-[13.5px] font-medium">
          Run setup
        </ShimmerLabel>
        {meta ? (
          <span className={cn(mono, "min-w-0 truncate text-muted-foreground tabular-nums")}>{meta}</span>
        ) : null}
        <span role="status" aria-live="polite" className="ml-auto flex shrink-0">
          <StatusMark mark={mark} word={word} />
        </span>
      </button>

      {open ? (
        <div className="flex flex-col border-t border-foreground/[0.06] animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none">
          <ol className="flex flex-col">
            {rows.map((r) => {
              const Icon = ROW_ICON[r.mark] ?? CheckIcon;
              return (
                <li key={r.key} className="flex items-center gap-2.5 px-3.5 py-2">
                  <span className="flex size-3.5 shrink-0 items-center justify-center">
                    <Icon
                      aria-hidden
                      className={cn(
                        "size-3 text-muted-foreground",
                        r.mark === "running" && "animate-spin motion-reduce:animate-none",
                      )}
                    />
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[13px]",
                      r.mark === "running" ? "text-foreground" : "text-foreground/80",
                    )}
                  >
                    {r.label}
                  </span>
                  {r.detail ? (
                    <span className={cn(mono, "min-w-0 flex-1 truncate text-muted-foreground")} title={r.detail}>
                      {r.detail}
                    </span>
                  ) : (
                    <span className="flex-1" />
                  )}
                  {r.word ? <span className="shrink-0 text-xs text-muted-foreground">{r.word}</span> : null}
                </li>
              );
            })}
          </ol>
          {children}
        </div>
      ) : null}
    </div>
  );
}
