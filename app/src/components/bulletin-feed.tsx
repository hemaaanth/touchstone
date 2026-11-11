import { FileCheck2, Megaphone, ShieldAlert } from "lucide-react"
import type { Fleet, Lead, LeadStatus, LeadTransition, Tier } from "@/lib/fleet"
import { leadStatus } from "@/lib/fleet"
import { earnsSuccessSignal } from "@/lib/fleet-policy"
import type { Severity } from "@/lib/types"
import { ago } from "@/lib/format"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"

// The Bulletin feed. Flat, full-width entries — square edges, a single bottom
// separator, no per-entry shadow or rounded frame (docs §6b). The two lanes are
// kept visibly separate: the trusted Bulletin, then the quarantined Evidence
// lane for untrusted Tier-2 submissions, which get no control implying
// trusted-peer access.

// How a status word reads. Only `proven` earns success ink; everything else —
// including `dismissed` — is neutral. A High/Critical lead stays neutral until
// it is proven.
const STATUS_LABEL: Record<LeadStatus, string> = {
  proposed: "Proposed",
  corroborated: "Corroborated",
  verifying: "Verifying",
  proven: "Proven",
  dismissed: "Dismissed",
}

function tierLabel(tier: Tier): string {
  return tier === 2 ? "T2 untrusted" : `T${tier}`
}

export function BulletinFeed({ fleet, leads }: { fleet: Fleet; leads: Lead[] }) {
  const nameOf = (id: string) => fleet.agents.find((a) => a.id === id)?.name ?? id
  const trusted = leads.filter((l) => l.lane === "bulletin")
  const evidence = leads.filter((l) => l.lane === "evidence")

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2.5">
        <Megaphone className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Bulletin</span>
        <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
          {trusted.length} trusted{evidence.length ? ` · ${evidence.length} evidence` : ""}
        </span>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        {leads.length === 0 ? (
          <p className="border-b px-4 py-8 text-center text-xs leading-relaxed text-muted-foreground">
            No leads posted yet. Hunters post here as they find something; nothing graduates to proven without a replay.
          </p>
        ) : (
          <>
            <LaneHeading icon={Megaphone} label="Bulletin" sub="Trusted lane — Tier-0/1 leads, triage, dispatch" count={trusted.length} />
            {trusted.length === 0 ? (
              <p className="border-b px-4 py-5 text-xs text-muted-foreground">No trusted leads yet.</p>
            ) : (
              trusted.map((l) => <LeadEntry key={l.id} lead={l} nameOf={nameOf} />)
            )}

            <LaneHeading
              icon={ShieldAlert}
              label="Evidence · quarantined"
              sub="Untrusted Tier-2 submissions — not promoted until the oracle replays them"
              count={evidence.length}
            />
            {evidence.length === 0 ? (
              <p className="border-b px-4 py-5 text-xs text-muted-foreground">No evidence submissions.</p>
            ) : (
              evidence.map((l) => <LeadEntry key={l.id} lead={l} nameOf={nameOf} />)
            )}
          </>
        )}
      </ScrollArea>
    </div>
  )
}

function LaneHeading({
  icon: Icon,
  label,
  sub,
  count,
}: {
  icon: typeof Megaphone
  label: string
  sub: string
  count: number
}) {
  return (
    <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2">
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-[11px] text-muted-foreground/70 tabular-nums">{count}</span>
      <span className="ml-auto truncate text-[10px] text-muted-foreground/70">{sub}</span>
    </div>
  )
}

// A neutral chip: an outline, muted text, no fill. Used for tags and for the
// severity chip BEFORE a lead is proven.
function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 items-center rounded border border-border px-1.5 text-[10px] font-medium text-muted-foreground", className)}>
      {children}
    </span>
  )
}

function SeverityChip({ severity, proven }: { severity: Severity; proven: boolean }) {
  const label = severity[0].toUpperCase() + severity.slice(1)
  // High/Critical turn hot ONLY once proven; until then they read neutral so an
  // unproven claim never borrows the alarm of a confirmed one.
  const hot = proven && (severity === "critical" || severity === "high")
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded border px-1.5 text-[10px] font-medium",
        hot ? "border-bad/40 bg-bad/10 text-bad" : "border-border text-muted-foreground",
      )}
    >
      {label}
    </span>
  )
}

function LeadEntry({ lead, nameOf }: { lead: Lead; nameOf: (id: string) => string }) {
  const status = leadStatus(lead)
  const proven = earnsSuccessSignal(lead)
  const quarantined = lead.lane === "evidence"

  return (
    <article className="border-b px-4 py-3">
      {/* Author / tier line. */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">{nameOf(lead.author)}</span>
        <Chip className={cn(lead.tier === 2 && "text-foreground/80")}>{tierLabel(lead.tier)}</Chip>
        {quarantined ? <Chip>quarantined</Chip> : null}
        <StatusWord status={status} />
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {ago(lead.transitions[lead.transitions.length - 1]?.at)}
        </span>
      </div>

      {/* Claim. */}
      <p className="mt-1.5 text-sm font-medium leading-snug">{lead.claim}</p>

      {/* Tags: module + toolkit + severity. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {lead.module ? <Chip>{lead.module}</Chip> : <Chip>free-form</Chip>}
        {lead.toolkit.map((t) => (
          <Chip key={t}>{t}</Chip>
        ))}
        <SeverityChip severity={lead.severity} proven={proven} />
      </div>

      {/* Mechanism. */}
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{lead.mechanism}</p>

      {/* Status timeline — RECORDED transitions only, never inferred. */}
      <StatusTimeline transitions={lead.transitions} nameOf={nameOf} />

      {/* Evidence link + reactions. */}
      <div className="mt-2 flex items-center gap-3">
        {lead.evidenceRef ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <FileCheck2 className="size-3" />
            <a href="#" onClick={(e) => e.preventDefault()} className="font-mono underline-offset-2 hover:underline">
              {lead.evidenceRef}
            </a>
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground/70">No evidence attached yet.</span>
        )}
        <Reactions reactions={lead.reactions} />
      </div>

      {quarantined ? (
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground/70">
          Submitted to the quarantined evidence lane. Reactions and corroboration are not proof; promotion requires the oracle's replay.
        </p>
      ) : null}
    </article>
  )
}

function StatusWord({ status }: { status: LeadStatus }) {
  const proven = status === "proven"
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded px-1.5 text-[10px] font-semibold",
        proven ? "bg-ok/10 text-ok" : "text-muted-foreground",
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  )
}

function StatusTimeline({
  transitions,
  nameOf,
}: {
  transitions: LeadTransition[]
  nameOf: (id: string) => string
}) {
  if (transitions.length === 0) return null
  return (
    <ol className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-[10px] text-muted-foreground">
      {transitions.map((t, i) => {
        const proven = t.status === "proven"
        return (
          <li key={`${t.status}-${t.at}`} className="flex items-center gap-1">
            {i > 0 ? <span className="text-muted-foreground/40">→</span> : null}
            <span className={cn("rounded px-1 py-px", proven ? "bg-ok/10 font-medium text-ok" : "bg-muted")}>
              {STATUS_LABEL[t.status]}
            </span>
            <span className="text-muted-foreground/60 tabular-nums">
              {ago(t.at)}
              {t.by ? ` · ${nameOf(t.by)}` : " · oracle"}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function Reactions({ reactions }: { reactions: Lead["reactions"] }) {
  if (reactions.length === 0) return null
  return (
    <div className="flex items-center gap-1">
      {reactions.map((r) => (
        <span
          key={r.emoji}
          className="inline-flex h-5 items-center gap-1 rounded-full border border-border px-1.5 text-[11px] text-muted-foreground tabular-nums"
          title={r.by.join(", ")}
        >
          <span>{r.emoji}</span>
          <span>{r.by.length}</span>
        </span>
      ))}
    </div>
  )
}
