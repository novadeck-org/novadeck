import { MessageSquare, MessageSquareWarning, Pause } from "lucide-react"

import type { MailBadge } from "../model/messages"

const icons = { waiting: MessageSquare, held: MessageSquareWarning, paused: Pause }

const tones = {
  waiting: "border-line bg-soft text-ink",
  // A release is the person's to give: it stands out as a warning does.
  held: "border-transparent bg-warning text-warning-fg",
  paused: "border-line bg-paper text-muted",
}

// How many messages wait for a terminal's agent, beside its name. Its words are the
// tab's description; this is what the eye catches.
export const MailCount = ({ badge }: { badge: MailBadge }): React.JSX.Element => {
  const Icon = icons[badge.kind]
  return (
    <span
      aria-hidden
      data-mail={badge.kind}
      className={`terminal-tab-mail inline-flex h-4 shrink-0 items-center gap-1 rounded-control border px-1 font-mono text-[10px] leading-none font-medium tabular-nums ${tones[badge.kind]}`}
    >
      <Icon size={10} strokeWidth={1.75} />
      {badge.count}
    </span>
  )
}
