// The units of time the core's clocks count in, and how its text counts things.

export const second = 1000
export const minute = 60 * second
export const hour = 60 * minute
export const day = 24 * hour

// A count with its noun, plural unless it is one: "1 task", "3 agents".
export const counted = (count: number, one: string): string =>
  `${count} ${one}${count === 1 ? "" : "s"}`
