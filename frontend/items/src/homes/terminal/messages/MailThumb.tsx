import { handleText } from "@novadeck/core/handle"

import { conversationsOf, listed } from "./conversations"
import type { MailHandle, MailLinks } from "./mail"

// The conversations: who they're with, as the pane lists them.
export const MailThumb = ({
  mail,
  links,
}: {
  mail: MailHandle
  links: MailLinks
}): React.JSX.Element => {
  const conversations = mail.mail ? listed(conversationsOf(mail.mail)) : []
  return (
    <span className="peek-plan peek-mail">
      <b>{conversations.length ? "Conversations" : "No messages yet"}</b>
      {conversations.slice(0, 4).map(({ key, peer }) => (
        <span key={key}>
          {peer === "you"
            ? "You"
            : `${links.peer(peer)?.name ?? handleText(peer)} · ${handleText(peer)}`}
        </span>
      ))}
    </span>
  )
}
