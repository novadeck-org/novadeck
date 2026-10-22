import { handleText } from "@novadeck/core/handle"

import type { MailHandle } from "./mail"

// The threads: the agents they're with, latest first.
export const MailThumb = ({
  mail,
  peerName,
}: {
  mail: MailHandle
  peerName: (handle: string) => string | undefined
}): React.JSX.Element => {
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
