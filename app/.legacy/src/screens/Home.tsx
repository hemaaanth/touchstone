import { AnswerCard } from "@/components/app/cards"
import { ChatColumn } from "@/components/app/chat"
import { homeChat, useActions } from "@/lib/actions"

/*
 * Home: the Answer above the agent chat.
 * The Answer card is pinned at the top so "is it good?" reads in seconds.
 * Below it the chat replays from fixtures; each turn renders its own card.
 * The composer sits at the bottom. The chat stops at the approval.
 * homeChat adds the turns your actions bring: the result after Approve,
 * or the Stop card after Stop all or Stop run.
 */

export function Home() {
  return <ChatColumn messages={homeChat(useActions())} top={<AnswerCard id="acme" />} />
}
