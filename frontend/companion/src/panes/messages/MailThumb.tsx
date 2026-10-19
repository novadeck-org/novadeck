import { handleText } from "@novadeck/core/handle"

import type { MessagesMember } from "../../bar"
import type { ThumbProps } from "../../registration"

// The threads: the agents they're with, latest first.
export const MailThumb = ({ mail, peerName }: ThumbProps<MessagesMember>): React.JSX.Element => {
  const threads = mail.mail?.threads ?? []
  return (
    <span className="peek-plan peek-mail">
      <b>{threads.length ? "Threads" : "No messages yet"}</b>
      {threads.slice(0, 4).map((thread) => (
        <span key={thread.id}>
          {peerName(thread.peer) ?? handleText(thread.peer)} · {handleText(thread.peer)}
        </span>
      ))}
    </span>
  )
}
