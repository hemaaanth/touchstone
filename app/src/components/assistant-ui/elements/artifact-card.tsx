"use client";

import type { ComponentProps, ReactNode } from "react";
import { ArrowUpRightIcon, FileTextIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { card, cardInteractive, mono, ShimmerLabel } from "./surfaces";

export function ArtifactCard({
  title,
  meta,
  generating = false,
  words = 0,
  preview,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "title" | "meta" | "generating" | "words" | "preview"
> & {
  title: string;
  meta: string;
  generating?: boolean;
  words?: number;
  /** Optional body under the header row, e.g. the tail of a drafting file. */
  preview?: ReactNode;
}) {
  return (
    <div
      data-slot="artifact-card"
      className={cn(
        card,
        cardInteractive,
        "group flex w-full max-w-xs flex-col gap-2.5 p-3",
        className,
      )}

      {...props}
    >
      <div className="flex items-center gap-3">
        <span className="bg-foreground/[0.05] text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
          <FileTextIcon
            className={cn(
              "size-4",
              generating && "animate-pulse motion-reduce:animate-none",
            )}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium">{title}</p>
          {generating ? (
            <p
              className={cn(
                mono,
                "text-muted-foreground flex items-center gap-1",
              )}
            >
              <ShimmerLabel className="relative inline-block leading-none">
                Writing
              </ShimmerLabel>
              <span>·</span>
              <span className="tabular-nums">{words} words</span>
            </p>
          ) : (
            <p
              className={cn(
                mono,
                "fade-in blur-in-[2px] animate-in text-muted-foreground duration-300 motion-reduce:animate-none",
              )}
            >
              {meta}
            </p>
          )}
        </div>
        <ArrowUpRightIcon className="text-foreground/35 size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      {preview}
    </div>
  );
}
