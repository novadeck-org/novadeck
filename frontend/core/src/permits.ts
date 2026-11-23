import type { ChatPermit } from "./conversation"

// What the person is told of a permit of the shipping gate that stands, in facts: on which
// words it was given, and until when it stands. Pure, on the person's clock, for the Inbox and
// the chat to say the same lines.

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

// A time of day as `HH:MM`, with the weekday before it where it is not the same day as `now`.
const at = (time: number, now: number): string => {
  const date = new Date(time)
  const today = new Date(now)
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  const same =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  return same ? clock : `${days[date.getDay()]} ${clock}`
}

// On whose words it was given: the person's own as they typed them, or Allow on its card.
export const permitBasis = (permit: ChatPermit): string =>
  permit.quote === null ? "You allowed it on its card" : `On your words: "${permit.quote}"`

// Until when it stands: until its end or its first use; once used, when it was and when its
// retry window ends.
export const permitStands = (permit: ChatPermit, now: number): string =>
  permit.usedAt === null
    ? `Stands until ${at(permit.until, now)}, or its first use`
    : `Used at ${at(permit.usedAt, now)} · ends ${at(permit.until, now)}`
