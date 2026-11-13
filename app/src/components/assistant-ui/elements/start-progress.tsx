"use client";

import { cn } from "@/lib/utils";
import type { StartProgress as Progress, StartState } from "@/lib/startup";
import { card, mono, ShimmerLabel, StatusMark, type Mark } from "./surfaces";

// The run's progress before the agent session opens, in the style of the
// assistant-ui generative order-status element: one card, a header with the
// live counts, and one row per stage with its own mark. Neutral throughout.
// A failed tool is a coverage gap, not a finding, so nothing turns red.

const MARK: Record<StartState, { mark: Mark; word?: string }> = {
  running: { mark: "running" },
  done: { mark: "done" },
  failed: { mark: "fail" },
  unavailable: { mark: "off", word: "Unavailable" },
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function StartProgress({ progress, live }: { progress: Progress; live: boolean }) {
  const running = live && progress.stages.some((s) => s.state === "running");
  const counts = [
    progress.tools ? `${plural(progress.tools, "tool")} (${progress.ran} ran)` : null,
    progress.leads != null ? `${plural(progress.leads, "lead")}${running ? " so far" : ""}` : null,
  ].filter(Boolean);
  return (
    <div className={cn(card, "flex flex-col")} role="status" aria-live="polite">
      <div className="flex items-baseline justify-between gap-3 px-4 py-3">
        <ShimmerLabel active={running} className="text-sm font-medium text-foreground">
          {running ? "Getting the run ready" : "Run setup"}
        </ShimmerLabel>
        {counts.length ? <span className="text-xs text-muted-foreground">{counts.join(" · ")}</span> : null}
      </div>
      <ol className="flex flex-col border-t border-border/60">
        {progress.stages.map((s) => {
          // A stage cannot keep running once the run stopped. Show it as not
          // finished instead of a spinner that never ends.
          const m = s.state === "running" && !live ? { mark: "off" as Mark, word: "Stopped" } : MARK[s.state];
          return (
            <li
              key={s.key}
              className="flex items-start justify-between gap-3 border-b border-border/40 px-4 py-2 last:border-b-0"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className={cn("text-xs", s.state === "running" && live ? "text-foreground" : "text-muted-foreground")}>
                  {s.label}
                </span>
                {s.detail ? <span className={cn(mono, "break-words text-muted-foreground")}>{s.detail}</span> : null}
              </div>
              <StatusMark mark={m.mark} word={m.word} />
            </li>
          );
        })}
      </ol>
    </div>
  );
}
