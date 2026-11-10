"use client";

import { useState } from "react";
import { Check, ChevronDown, ChevronRight, FileCode2, FileText, Files, ShieldCheck } from "lucide-react";
import type { ArtifactDoc, ArtifactKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ShimmerLabel } from "./surfaces";

// The run's files, in a small panel that floats in the chat's top-right corner.
// It replaces the old header chip and tab strip. Those showed every file at once
// and ran out of room past a few files. Here the panel folds down to one line
// ("Files 11"). Open, it lists each file once, grouped by kind. A file the agent
// rewrote shows its versions under it, like a file tree. A click opens that one
// file in the document pane. Inspired by the assistant-ui file tree and server
// panel elements: one row per item, one expanded at a time.

const GROUPS: { kind: ArtifactKind; label: string }[] = [
  { kind: "proof", label: "Replay proofs" },
  { kind: "poc", label: "Tests" },
  { kind: "report", label: "Reports" },
  { kind: "source", label: "Sources" },
];

function iconFor(doc: ArtifactDoc) {
  if (doc.kind === "proof") return ShieldCheck;
  if (doc.kind === "report") return FileText;
  return FileCode2;
}

export function FilesPanel({
  docs,
  activeId,
  activeVersionId,
  open,
  onOpenChange,
  onOpen,
}: {
  docs: ArtifactDoc[];
  activeId: string | null;
  activeVersionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: (fileId: string, versionId?: string) => void;
}) {
  // One file shows its versions at a time. It follows the open file: when the
  // pane moves to another file, that file's versions show here.
  const [expanded, setExpanded] = useState<string | null>(activeId);
  const [seenActive, setSeenActive] = useState(activeId);
  if (activeId !== seenActive) {
    setSeenActive(activeId);
    if (activeId) setExpanded(activeId);
  }
  const writing = docs.some((d) => d.versions.some((v) => v.writing));
  const groups = GROUPS.map((g) => ({ ...g, docs: docs.filter((d) => d.kind === g.kind) })).filter(
    (g) => g.docs.length,
  );

  return (
    <div
      className={cn(
        "pointer-events-auto flex max-h-[min(28rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl border border-border/60 bg-popover/90 shadow-lg backdrop-blur-md",
        open ? "w-72 max-w-[calc(100vw-1.5rem)]" : "w-auto",
      )}
    >
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="flex shrink-0 items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Files className="size-3.5 shrink-0" />
        <span className="font-medium text-foreground">Files</span>
        <span className="tabular-nums">{docs.length}</span>
        {writing ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-current motion-reduce:animate-none" /> : null}
        <ChevronDown className={cn("ml-auto size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        <div className="min-h-0 overflow-y-auto border-t border-border/60 py-1">
          {groups.map((g) => (
            <div key={g.kind} className="py-0.5">
              {groups.length > 1 ? (
                <div className="px-3 pt-1.5 pb-1 text-[11px] text-muted-foreground">{g.label}</div>
              ) : null}
              {g.docs.map((d) => (
                <FileRow
                  key={d.id}
                  doc={d}
                  active={d.id === activeId}
                  activeVersionId={d.id === activeId ? activeVersionId : null}
                  expanded={expanded === d.id}
                  onToggle={() => setExpanded((cur) => (cur === d.id ? null : d.id))}
                  onOpen={onOpen}
                />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// The group label already says "Replay proofs", so a proof row drops the
// matching prefix from its title and leads with the test it proves.
function shortTitle(doc: ArtifactDoc) {
  return doc.kind === "proof" ? doc.title.replace(/^Replay proof\s*[—–-]\s*/i, "") : doc.title;
}

const row =
  "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-foreground/[0.05]";

function FileRow({
  doc,
  active,
  activeVersionId,
  expanded,
  onToggle,
  onOpen,
}: {
  doc: ArtifactDoc;
  active: boolean;
  activeVersionId: string | null;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (fileId: string, versionId?: string) => void;
}) {
  const Icon = iconFor(doc);
  const latest = doc.versions[doc.versions.length - 1];
  const multi = doc.versions.length > 1;
  return (
    <div className="px-1">
      <div className={cn(row, "group pr-1", active && "bg-foreground/[0.06] text-foreground")}>
        <button
          type="button"
          onClick={() => {
            onOpen(doc.id);
            if (multi && !expanded) onToggle();
          }}
          className="flex min-w-0 flex-1 items-center gap-2"
          title={doc.title}
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={cn("min-w-0 truncate", !active && "text-foreground/85")}>{shortTitle(doc)}</span>
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
          {latest?.writing ? <ShimmerLabel active>Writing</ShimmerLabel> : multi ? `v${doc.versions.length}` : null}
        </span>
        {multi ? (
          <button
            type="button"
            onClick={onToggle}
            aria-label={expanded ? "Hide versions" : "Show versions"}
            aria-expanded={expanded}
            className="-mr-0.5 rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
          </button>
        ) : null}
      </div>

      {multi && expanded ? (
        <div className="ml-[13px] border-l border-border/60 pl-1.5">
          {doc.versions.map((v, i) => {
            const on = active && v.id === activeVersionId;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => onOpen(doc.id, v.id)}
                className={cn(row, "py-0.5 text-xs text-muted-foreground", on && "bg-foreground/[0.06] text-foreground")}
              >
                <span className="font-mono">v{i + 1}</span>
                {v.attempt != null ? <span>attempt {v.attempt}</span> : null}
                <span className="ml-auto flex items-center gap-1">
                  {v.writing ? (
                    <ShimmerLabel active>Writing</ShimmerLabel>
                  ) : v.state === "pass" ? (
                    <>
                      <Check className="size-3" />
                      Passed
                    </>
                  ) : v.state === "fail" ? (
                    "Failed"
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
