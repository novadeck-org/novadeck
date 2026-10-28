import { handleText } from "@novadeck/core/handle"

import { conversationsOf, listed, youKey } from "./conversations"
import { usePeers, type MessagesHandle, type MessageLinks } from "./messages"

// The conversations: who they're with, as the pane lists them.
export const MessagesThumb = ({
  messagesHandle,
  links,
}: {
  messagesHandle: MessagesHandle
  links: MessageLinks
}): React.JSX.Element => {
  const peers = usePeers(links)
  const conversations = messagesHandle.threads
    ? listed(conversationsOf(messagesHandle.threads))
    : []
  return (
    <span className="peek-plan peek-messages">
      <b>{conversations.length ? "Conversations" : "No messages yet"}</b>
      {conversations.slice(0, 4).map(({ key, peer }) => (
        <span key={key}>
          {key === youKey
            ? "You"
            : `${peers[peer]?.name ?? handleText(peer)} · ${handleText(peer)}`}
        </span>
      ))}
    </span>
  )
}
