import { handleText } from "@novadeck/core/handle"

import { conversationsOf, listed } from "./conversations"
import { usePeers, type MessagesHandle, type MessageLinks } from "./messages"

// The conversations: who they're with, as the pane lists them.
export const MessagesThumb = ({
  view,
  links,
}: {
  view: MessagesHandle
  links: MessageLinks
}): React.JSX.Element => {
  const peers = usePeers(links)
  const conversations = view.threads ? listed(conversationsOf(view.threads)) : []
  return (
    <span className="peek-plan peek-messages">
      <b>{conversations.length ? "Conversations" : "No messages yet"}</b>
      {conversations.slice(0, 4).map(({ key, peer }) => (
        <span key={key}>
          {peer === "you"
            ? "You"
            : `${peers[peer]?.name ?? handleText(peer)} · ${handleText(peer)}`}
        </span>
      ))}
    </span>
  )
}
