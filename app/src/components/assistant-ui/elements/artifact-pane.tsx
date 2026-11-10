"use client";

import { FileCode2, ShieldCheck, X } from "lucide-react";
import type { ArtifactDoc, Finding } from "@/lib/types";
import { cn } from "@/lib/utils";
import { codeScroll, codeSurface, ShimmerLabel } from "./surfaces";
import { StreamingCode, StreamingText } from "./streaming-text";
import { ReplayProof } from "@/components/replay-proof";

// The workspace pane beside the chat. The agent's live documents — the PoC it is
// drafting, the replay proof it lands — open here instead of scrolling past in
// the transcript, so the operator reads the whole file while the run keeps
// moving. Code arrives as growing snapshots, highlighted monochrome with its
// fresh tail fading in; a proof document renders the recorded finding's
// structured replay report. When more than one document is open the header
// becomes a tab strip so the operator can move between them without leaving the
// pane. One accent rule holds: a proof leads with the shield and the proven
// green lives inside its report, never on the chrome here.
const KIND_META: Record<ArtifactDoc["kind"], string> = {
  poc: "Proof of concept",
  proof: "Replay proof",
  source: "Source",
  report: "Report",
};

function isCodeDoc(doc: ArtifactDoc) {
  return doc.lang === "solidity" || doc.kind === "poc" || doc.kind === "source";
}

function iconFor(doc: ArtifactDoc) {
  return doc.kind === "proof" ? ShieldCheck : FileCode2;
}

export function ArtifactPane({
  docs,
  activeId,
  finding,
  onSelect,
  onClose,
}: {
  docs: ArtifactDoc[];
  activeId: string | null;
  finding: Finding | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const doc = docs.find((d) => d.id === activeId) ?? docs[docs.length - 1];
  if (!doc) return null;

  const multi = docs.length > 1;
  const Icon = iconFor(doc);
  const code = isCodeDoc(doc);
  const proof = doc.kind === "proof";
  const words = doc.text.trim() ? doc.text.trim().split(/\s+/).length : 0;

  return (
    <aside
      className={cn(
        // Mobile: a full-width overlay above the chat, so a 27rem column never
        // squeezes the transcript off-screen or forces the code to wrap.
        "absolute inset-y-0 right-0 z-20 flex h-full w-full min-w-0 flex-col bg-background",
        // Desktop: the fixed side column beside the chat.
        "md:static md:z-auto md:w-[27rem] md:shrink-0 md:border-l md:bg-muted/20",
      )}
    >
      <header className="flex h-12 shrink-0 items-center gap-1 border-b pe-1.5 ps-1.5">
        {multi ? (
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {docs.map((d) => {
              const TabIcon = iconFor(d);
              const active = d.id === doc.id;
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => onSelect(d.id)}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                    active
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  <TabIcon className="size-3.5 shrink-0" />
                  <span className="max-w-[8.5rem] truncate">{d.title}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium leading-tight">
                {doc.title}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {proof ? (
                  KIND_META.proof
                ) : doc.writing ? (
                  <ShimmerLabel active>Writing · {words} words</ShimmerLabel>
                ) : (
                  `${KIND_META[doc.kind]} · ${words} words`
                )}
              </span>
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close document"
          className="ml-auto shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {proof ? (
          finding ? (
            <div className="px-4 py-4">
              <ReplayProof finding={finding} />
            </div>
          ) : (
            <div className="px-4 py-6 text-xs text-muted-foreground">
              Loading the replay proof…
            </div>
          )
        ) : code ? (
          <div className={codeScroll}>
            <pre
              className={cn(
                codeSurface,
                "whitespace-pre px-4 py-3 font-mono text-[12px] leading-relaxed text-foreground/90",
              )}
            >
              <StreamingCode
                text={doc.text}
                lang={doc.lang ?? null}
                streaming={doc.writing}
              />
            </pre>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap px-4 py-3 font-sans text-[12px] leading-relaxed text-foreground/90">
            <StreamingText text={doc.text} streaming={doc.writing} />
          </pre>
        )}
      </div>
    </aside>
  );
}
