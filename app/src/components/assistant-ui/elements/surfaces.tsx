"use client";

import type { ComponentProps } from "react";
import { useRef, useState } from "react";
import { CheckIcon, ClockIcon, Loader2Icon, MinusIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsomorphicLayoutEffect } from "../utils/useIsomorphicLayoutEffect";

export const paper = "bg-background border border-border/60 dark:bg-popover";

// Every card in the run transcript uses this one surface: the same radius,
// border and fill. Status never tints a card. Its colour lives only in the
// StatusMark, so a passed card and a failed card have the same shape.
export const card = "bg-background border border-border/60 rounded-xl dark:bg-popover";

// A card you can click. Hover only lifts the border and fill a little. It does
// not move, scale or glow.
export const cardInteractive =
  "cursor-pointer transition-colors hover:border-foreground/20 hover:bg-foreground/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15";

export const floating = "bg-background border border-border/60 dark:bg-popover";

export const field =
  "bg-foreground/[0.04] forced-colors:border dark:bg-foreground/[0.06]";

export const fieldInteractive =
  "bg-foreground/[0.04] transition-colors hover:bg-foreground/[0.07] forced-colors:border dark:bg-foreground/[0.06] dark:hover:bg-foreground/[0.09]";

export const pressable =
  "transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.96] motion-reduce:transition-none";

export const ghostButton =
  "flex items-center justify-center rounded-full text-muted-foreground outline-hidden transition-[background-color,color,scale] duration-150 hover:bg-foreground/[0.06] hover:text-foreground/90 active:scale-[0.96] focus-visible:ring-1 focus-visible:ring-foreground/20 motion-reduce:transition-none dark:hover:bg-foreground/[0.09]";

export const inkButton =
  "bg-foreground text-background transition-[opacity,scale] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:opacity-90 active:scale-[0.96] motion-reduce:transition-none forced-colors:border";

export const iconSwap =
  "[grid-area:1/1] transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none";

export const iconSwapIn = "scale-100 opacity-100 blur-none";

export const iconSwapOut = "scale-[0.25] opacity-0 blur-[4px]";

export const labelSwap =
  "col-start-1 row-start-1 flex w-max items-center gap-1.5 leading-none transition-[opacity,filter] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none";

export const labelSwapIn = "opacity-100 blur-none";

export const labelSwapOut =
  "pointer-events-none select-none opacity-0 blur-[2px]";

export const collapsePanel =
  "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] data-[ending-style]:h-0 data-[starting-style]:h-0 motion-reduce:transition-none";

export const live = "text-blue-500 dark:text-blue-400";

export const mono = "font-mono text-[11px] tracking-tight";

// The one way a card shows its state: a small icon and one word, top right.
// Colour is rare (docs/restraint.md). Only "Proven" is green: a Foundry replay
// proved the finding. A failed attempt is normal work, so it stays grey.
export type Mark = "running" | "writing" | "done" | "pass" | "fail" | "proven" | "waiting" | "off";

const MARK: Record<Mark, { word: string; ink: string }> = {
  running: { word: "Running", ink: "text-muted-foreground" },
  writing: { word: "Writing", ink: "text-muted-foreground" },
  waiting: { word: "Waiting", ink: "text-muted-foreground" },
  done: { word: "Done", ink: "text-muted-foreground" },
  pass: { word: "Passed", ink: "text-foreground" },
  proven: { word: "Proven", ink: "text-ok" },
  fail: { word: "Failed", ink: "text-muted-foreground" },
  off: { word: "Not proven", ink: "text-muted-foreground" },
};

export function StatusMark({
  mark,
  word,
  className,
}: {
  mark: Mark;
  /** Override the word, e.g. "Running 3/5". The icon and tone stay. */
  word?: string;
  className?: string;
}) {
  const m = MARK[mark];
  const Icon =
    mark === "running" || mark === "writing"
      ? Loader2Icon
      : mark === "fail"
        ? XIcon
        : mark === "waiting"
          ? ClockIcon
          : mark === "off"
            ? MinusIcon
            : CheckIcon;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 text-xs font-medium",
        m.ink,
        className,
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "size-3.5",
          (mark === "running" || mark === "writing") &&
            "animate-spin motion-reduce:animate-none",
        )}
      />
      {word ?? m.word}
    </span>
  );
}

export function ShimmerLabel({
  active = true,
  className,
  ...props
}: ComponentProps<"span"> & { active?: boolean }) {
  return (
    <span
      className={cn(active && "shimmer motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

/**
 * Scroll region for content that keeps its own whitespace. `whitespace-pre` in
 * a bounded box clips a long line with no way to reach it, so the rows scroll
 * instead.
 *
 * `codeSurface` wraps all the rows as one block, and the rows are its children.
 * It cannot go on each row: `min-width: 100%` resolves against the scroll
 * container's visible width rather than its scroll width, so a per-row width
 * leaves every row except the longest ending its background at the fold.
 */
export const codeScroll = "overflow-x-auto";

export const codeSurface = "w-max min-w-full";

export function SwapLabel({
  active,
  children,
  className,
}: {
  active: 0 | 1;
  children: [React.ReactNode, React.ReactNode];
  className?: string;
}) {
  const layers = [useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null)];
  const [width, setWidth] = useState<number | null>(null);

  useIsomorphicLayoutEffect(() => {
    const target = layers[active]?.current;
    if (!target) return undefined;
    const measure = () =>
      setWidth(Math.ceil(target.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, [active]);

  return (
    <span
      style={width === null ? undefined : { width }}
      className={cn(
        "grid overflow-x-clip transition-[width] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
        className,
      )}
    >
      {children.map((layer, index) => (
        <span
          key={index}
          ref={layers[index]}
          aria-hidden={active !== index}
          className={cn(
            labelSwap,
            active === index ? labelSwapIn : labelSwapOut,
          )}
        >
          {layer}
        </span>
      ))}
    </span>
  );
}
