"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { tokenize, type TokenClass } from "@/lib/highlight";

// Smooth reveal for streamed prose and thinking. Our transport sends the whole
// text so far, in uneven chunks, so painting each snapshot makes text jump in
// blocks. This hook shows a prefix that walks toward the full text a few words
// per frame. It moves faster when it falls behind, so it never lags more than a
// fraction of a second. It cuts at word ends, so a word never shows half typed.
// The caller renders the prefix as Markdown; an open table or list closes when
// the rest arrives. A block that is not streaming shows its whole text.
// This is the assistant-ui "streaming-text" idea, word by word, without the
// blue tint: one accent colour belongs to proven findings.
export function useSmoothText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(() => (streaming ? 0 : text.length));
  const target = useRef(text);
  const pos = useRef(shown);
  useEffect(() => {
    target.current = text;
  }, [text]);
  useEffect(() => {
    if (!streaming) return;
    let raf = 0;
    let last = performance.now();
    let painted = 0;
    const tick = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      const full = target.current;
      if (pos.current > full.length) pos.current = full.length;
      const backlog = full.length - pos.current;
      if (backlog > 0) {
        // At least ~60 chars a second; a big backlog drains in ~350ms.
        pos.current = Math.min(full.length, pos.current + Math.max(0.06, backlog / 350) * dt);
        // Paint at most ~25 times a second: each paint parses Markdown.
        if (now - painted > 40) {
          painted = now;
          const at = Math.floor(pos.current);
          const rest = full.slice(at).search(/\s/);
          setShown(rest < 0 ? at : at + rest);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [streaming]);
  return streaming ? text.slice(0, shown) : text;
}

// A streamed CODE document that reveals newly-arrived text with a soft fade.
// Our transport hands the FULL text each tick (a growing snapshot), so we diff
// against what we last showed and fade only the fresh tail.
// The file is highlighted by our dependency-free lexer — monochrome, so the one-accent rule
// holds inside code too (weight and opacity carry the structure, never hue) —
// and only the freshly-arrived tail fades in. Our documents grow a whole line at
// a time, so the stable/fresh split always lands on a line boundary; tokenizing
// each part on its own therefore never splits a token across the seam.
const SYNTAX: Record<TokenClass, string> = {
  keyword: "font-medium text-foreground",
  type: "text-foreground/90",
  string: "text-muted-foreground",
  number: "text-foreground/80",
  comment: "text-muted-foreground/60 italic",
  text: "",
};

function highlight(
  code: string,
  lang: string | null,
  keyBase: string,
): ReactNode[] {
  return tokenize(code, lang).map((t, i) =>
    t.cls === "text" ? (
      <span key={`${keyBase}-${i}`}>{t.value}</span>
    ) : (
      <span key={`${keyBase}-${i}`} className={SYNTAX[t.cls]}>
        {t.value}
      </span>
    ),
  );
}

export function StreamingCode({
  text,
  lang,
  streaming,
}: {
  text: string;
  lang: string | null;
  streaming: boolean;
}) {
  const shown = useRef(0);
  const prev = Math.min(shown.current, text.length);
  const stable = text.slice(0, prev);
  const fresh = text.slice(prev);
  useEffect(() => {
    shown.current = text.length;
  });

  if (!streaming) return <>{highlight(text, lang, "all")}</>;
  return (
    <>
      {highlight(stable, lang, "stable")}
      {fresh ? (
        <span
          key={prev}
          className="animate-in fade-in duration-700 ease-out motion-reduce:animate-none"
        >
          {highlight(fresh, lang, "fresh")}
        </span>
      ) : null}
    </>
  );
}
