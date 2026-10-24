// The clocks a waiting agent's rows, window bar and card read, apart from what its tab needs
// to be drawn, so the views that show them load when one does.

const second = 1000
const minute = 60 * second
const hour = 60 * minute

// How long a job has run, short, for its tab: "<1m", "4m", then "2h".
export const minutesWaited = (since: number, now = Date.now()): string => {
  const elapsed = Math.max(0, now - since)
  if (elapsed < minute) return "<1m"
  return elapsed < hour ? `${Math.floor(elapsed / minute)}m` : `${Math.floor(elapsed / hour)}h`
}

// "8:14", the time left to `at`, for a window's countdown.
const countdown = (at: number, now: number): string => {
  const left = Math.max(0, Math.ceil((at - now) / second))
  const seconds = String(left % 60).padStart(2, "0")
  return left >= 3600
    ? `${Math.floor(left / 3600)}:${String(Math.floor((left % 3600) / 60)).padStart(2, "0")}:${seconds}`
    : `${Math.floor(left / 60)}:${seconds}`
}

// How a wake-up's time left reads, for a window and its card: "in 8:14", or "due" once its
// time has come and the agent hasn't yet taken its turn.
export const wakeIn = (at: number, now = Date.now()): string =>
  at <= now ? "due" : `in ${countdown(at, now)}`
