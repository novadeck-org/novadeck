// Sessions are named after the minute they started, e.g. "Sep 26, 14:05".
export const sessionName = (now: number): string =>
  new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now)
