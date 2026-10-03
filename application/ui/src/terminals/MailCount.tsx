import { MessageSquare, MessageSquareWarning, Pause } from "lucide-react"

import type { MailBadge } from "../model/messages"

const icons = { waiting: MessageSquare, held: MessageSquareWarning, paused: Pause }

// Held mail is the person's to release: it stands out as a warning does.
const tones = { waiting: undefined, held: "warning", paused: undefined } as const

// How many messages wait for a terminal's agent, beside its name. Its words are the
// tab's description; this is what the eye catches.
export const MailCount = ({ badge }: { badge: MailBadge }): React.JSX.Element => {
  const Icon = icons[badge.kind]
  return (
    <span
      aria-hidden
      data-mail={badge.kind}
      data-tone={tones[badge.kind]}
      className="terminal-tab-mail badge inline-flex h-4 shrink-0 items-center gap-1 px-1 text-[10px] leading-none font-medium tabular-nums"
    >
      <Icon size={10} strokeWidth={1.75} />
      {badge.count}
    </span>
  )
}
