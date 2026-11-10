import type { ReactNode } from "react"
import type { CardKind } from "@/data/fixtures"
import { BlockedCard, ScopeProposalCard, SetupNeededCard, StopCard } from "./consent"
import { AnswerCard, ApprovalCard, FindingCard, PlanCard, ResultCard, RunProgressCard } from "./core"

/*
 * The ten MVP chat cards. A chat message names a card as { kind, id }.
 * ChatCard turns that into the component. Every card takes { id }.
 */

export { CardFrame, MissingCard, PanelLink } from "./frame"
export { AnswerCard, ApprovalCard, FindingCard, PlanCard, ResultCard, RunProgressCard } from "./core"
export { BlockedCard, ScopeChanges, ScopeProposalCard, SetupNeededCard, StopCard } from "./consent"

const CARDS: Record<CardKind, (props: { id: string }) => ReactNode> = {
  answer: AnswerCard,
  "scope-proposal": ScopeProposalCard,
  plan: PlanCard,
  approval: ApprovalCard,
  "run-progress": RunProgressCard,
  result: ResultCard,
  finding: FindingCard,
  blocked: BlockedCard,
  stop: StopCard,
  "setup-needed": SetupNeededCard,
}

export function ChatCard({ kind, id }: { kind: CardKind; id: string }) {
  const Card = CARDS[kind]
  return <Card id={id} />
}
