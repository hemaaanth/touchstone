import type { RunEvent, RunSummary } from "../types"
import { streamingFixture } from "./streaming"

// Named `.events` sequences the DEV shell can replay through useRun without a
// server or a live model. Keyed by the name after `fixture:` in a run id.
const FIXTURES: Record<string, RunEvent[]> = {
  streaming: streamingFixture,
}

export function getFixture(name: string): RunEvent[] {
  return FIXTURES[name] ?? []
}

// The sidebar rows the DEV shell offers so a fixture run is selectable. Not
// shipped in a production build — the shell gates these behind import.meta.env.DEV.
export const fixtureRuns: RunSummary[] = [
  {
    id: "fixture:streaming",
    alias: "ds-abl",
    status: "running",
    startedAt: 0, // stamped at mount by the shell so the elapsed clock ticks.
    title: "Vault.sol — withdraw() path",
    severity: "high",
  },
]
