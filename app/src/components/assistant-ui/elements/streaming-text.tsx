"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { tokenize, type TokenClass } from "@/lib/highlight";

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
