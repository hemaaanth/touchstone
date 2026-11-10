"use client";

import { Check, FileCode2, ShieldCheck, X } from "lucide-react";
import type { ArtifactDoc, ArtifactVersion, Finding } from "@/lib/types";
import { cn } from "@/lib/utils";
import { codeScroll, codeSurface, ShimmerLabel } from "./surfaces";
import { StreamingCode, StreamingText } from "./streaming-text";
import { ReplayProof } from "@/components/replay-proof";
import { ResizeHandle, useStoredWidth } from "@/components/resize-handle";

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
  versionId,
  finding,
  onSelect,
  onSelectVersion,
  onClose,
}: {
  docs: ArtifactDoc[];
  activeId: string | null;
  versionId: string | null;
  finding: Finding | null;
  onSelect: (id: string) => void;
  onSelectVersion: (versionId: string) => void;
  onClose: () => void;
}) {
  const [width, setWidth, initialWidth] = useStoredWidth("ts.paneWidth", 432, 320, 1100);
  const doc = docs.find((d) => d.id === activeId) ?? docs[docs.length - 1];
  if (!doc) return null;

  const version =
    doc.versions.find((v) => v.id === versionId) ?? doc.versions[doc.versions.length - 1];
  if (!version) return null;

  const multi = docs.length > 1;
  const Icon = iconFor(doc);
  const code = isCodeDoc(doc);
  const proof = doc.kind === "proof";
  const words = version.text.trim() ? version.text.trim().split(/\s+/).length : 0;

  return (
    <aside
      style={{ "--pane-width": `${width}px` } as React.CSSProperties}
      className={cn(
        // Mobile: a full-width overlay above the chat, so a narrow column never
        // squeezes the transcript off-screen or forces the code to wrap.
        "absolute inset-y-0 right-0 z-20 flex h-full w-full min-w-0 flex-col bg-background",
        // Desktop: a side column beside the chat, as wide as the operator drags
        // it, but never so wide the chat loses its own room.
        "md:relative md:z-auto md:w-(--pane-width) md:max-w-[65%] md:shrink-0 md:border-l md:bg-muted/20",
      )}
    >
      <ResizeHandle edge="left" width={width} onWidth={setWidth} initial={initialWidth} label="Resize document pane" />
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
                ) : version.writing ? (
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

      {/* The version switcher: one chip per rewrite of this file, so the same PoC
          iterated across attempts reads as v1/v2/v3 the operator can step
          through. A passed version carries a quiet check; the proven green stays
          inside the replay report, never on this chrome. Single-version files
          (an unrevised doc, the proof) show no bar. */}
      {doc.versions.length > 1 ? (
        <VersionBar
          versions={doc.versions}
          activeId={version.id}
          onSelect={onSelectVersion}
        />
      ) : null}

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
                text={version.text}
                lang={doc.lang ?? null}
                streaming={version.writing}
              />
            </pre>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap px-4 py-3 font-sans text-[12px] leading-relaxed text-foreground/90">
            <StreamingText text={version.text} streaming={version.writing} />
          </pre>
        )}
      </div>
    </aside>
  );
}

// The row of version chips under the header. Each chip is one write of the file;
// the active one is filled, the rest are quiet. A version whose replay passed
// carries a small check so the operator can see at a glance which rewrite proved
// out — monochrome, because the one green accent belongs to the finding.
function VersionBar({
  versions,
  activeId,
  onSelect,
}: {
  versions: ArtifactVersion[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1.5">
      {versions.map((v, i) => {
        const active = v.id === activeId;
        return (
          <button
            key={v.id}
            type="button"
            onClick={() => onSelect(v.id)}
            aria-current={active}
            title={v.state === "pass" ? "Replay passed" : v.state === "fail" ? "Replay failed" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[11px] transition-colors",
              active
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <span>v{i + 1}</span>
            {v.state === "pass" ? <Check className="size-3 shrink-0" /> : null}
            {v.writing ? (
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
