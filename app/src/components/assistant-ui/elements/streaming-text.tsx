"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

// Prose that reveals newly-arrived text with a soft fade instead of popping each
// snapshot in whole, so a live stream reads as the agent typing rather than text
// blinking in. Our transport hands the FULL text each tick (a growing snapshot),
// so we diff against what we last showed and fade only the fresh tail; the older
// text is already settled and never re-animates. Once the block is no longer the
// live tail (`streaming` false) it renders as plain settled text with no caret.
//
// This is the assistant-ui "streaming-text" leaf, adapted to our snapshot model
// and restyled base-nova (monochrome caret, no color).
export function StreamingText({
  text,
  streaming,
  className,
}: {
  text: string;
  streaming: boolean;
  className?: string;
}) {
  const shown = useRef(0);
  // Clamp in case a snapshot replaced the text wholesale (shorter than before).
  const prev = Math.min(shown.current, text.length);
  const stable = text.slice(0, prev);
  const fresh = text.slice(prev);
  useEffect(() => {
    shown.current = text.length;
  });

  if (!streaming) return <span className={className}>{text}</span>;
  return (
    <span className={className}>
      {stable}
      {fresh ? (
        // Keyed by the stable length so each new chunk remounts and re-fades.
        <span
          key={prev}
          className="animate-in fade-in duration-700 ease-out motion-reduce:animate-none"
        >
          {fresh}
        </span>
      ) : null}
      <Caret />
    </span>
  );
}

// A thin caret that blinks at the tail of a block still being written.
function Caret() {
  return (
    <span
      className={cn(
        "ml-0.5 inline-block h-[0.9em] w-[2px] translate-y-[2px] rounded-full align-baseline",
        "animate-pulse bg-foreground/70 motion-reduce:animate-none",
      )}
    />
  );
}
