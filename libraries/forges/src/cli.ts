import type { Problem, Ran } from "./forge.js"

/** A failed run as a Problem: a missing tool, one too slow, or `exit` as the caller reads it. */
export const failure = (
  ran: Extract<Ran, { ok: false }>,
  onExit: (said: string) => Problem,
): Problem =>
  ran.kind === "missing"
    ? { kind: "missing" }
    : ran.kind === "timeout"
      ? { kind: "unreachable" }
      : onExit(ran.said)

export const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
