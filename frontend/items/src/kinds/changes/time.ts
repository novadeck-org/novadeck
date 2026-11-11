// When a layer happened, short: the time of day for today, else the day.
export const timeLabel = (time: number | null, now = Date.now()): string => {
  if (time === null) return "now"
  const then = new Date(time)
  const today = new Date(now)
  if (then.toDateString() === today.toDateString())
    return then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  const sameYear = then.getFullYear() === today.getFullYear()
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "2-digit" }),
  })
}
