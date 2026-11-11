"use client";

import { useState, type ComponentProps, type ReactNode } from "react";
import { ArrowRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// One message between two agents in a fleet: who sent it, who got it, when,
// and the text. Each name is a pill. A pill with a click handler opens that
// agent's thread; a pill without one is inert (it names the thread you are in).
// `highlighted` marks the card a pill just jumped to. The highlight fades out
// when the caller clears it. `long` folds the body to a few lines behind
// "Show more", for the long briefs agents send each other.
export function AgentHandoff({
  from,
  to,
  time,
  text,
  long,
  onFrom,
  onTo,
  highlighted,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "onToggle"> & {
  from: string;
  to: string;
  time?: string;
  text: ReactNode;
  long?: boolean;
  onFrom?: () => void;
  onTo?: () => void;
  highlighted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const folded = long && !open;
  return (
    <div
      data-slot="agent-handoff"
      className={cn(
        "flex w-full max-w-160 flex-col gap-2 rounded-[10px] border bg-background px-3 py-2.5 transition-colors duration-700",
        highlighted && "border-foreground/15 bg-muted duration-150",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Pill name={from} onClick={onFrom} />
        <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
        <Pill name={to} onClick={onTo} />
        {time ? <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground tabular-nums">{time}</span> : null}
      </div>
      <div
        className={cn(
          "text-[13px] leading-[19px] text-foreground [overflow-wrap:anywhere]",
          folded && "max-h-[95px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]",
        )}
      >
        {text}
      </div>
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="self-start text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

const pill =
  "min-w-0 truncate rounded-full border bg-background px-[9px] py-[3px] text-xs leading-[15px] font-medium text-foreground";

function Pill({ name, onClick }: { name: string; onClick?: () => void }) {
  if (!onClick) return <span className={pill}>{name}</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Open ${name}`}
      className={cn(
        pill,
        "cursor-pointer transition-colors outline-none hover:border-foreground/15 hover:bg-muted focus-visible:ring-2 focus-visible:ring-foreground/15",
      )}
    >
      {name}
    </button>
  );
}
