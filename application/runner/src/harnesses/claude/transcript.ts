import type { ActivityEvent } from "../events.js"

/** The session a transcript belongs to, as its events name it. */
export type TranscriptSession = {
  readonly sessionId: string
  readonly instance: string | null
}

// Claude Code's records of an interrupted turn: Esc while it works or runs a tool, and
// "No" to a permission request, which interrupts the turn too. Only these exact texts
// count, so a prompt that merely starts like one does not.
const marker = "[Request interrupted by user"
const interruptions = new Set([`${marker}]`, `${marker} for tool use]`])

/**
 * What one line of Claude Code's session transcript says that its hooks do not: that the
 * person interrupted the turn. No hook fires for Esc or for a denied request, but the
 * transcript records the interruption, which ends the turn and settles its requests.
 * Subagents keep their own transcripts, so every line here is the root agent's.
 */
export const transcriptEvents = (
  line: string,
  { sessionId, instance }: TranscriptSession,
): readonly ActivityEvent[] => {
  // Most lines are long tool results; only one that mentions the marker needs parsing.
  if (!line.includes(marker)) return []
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return []
  }
  if (typeof record !== "object" || record === null) return []
  const { type, isSidechain, timestamp, message } = record as Record<string, unknown>
  if (type !== "user" || isSidechain === true || typeof timestamp !== "string") return []
  const startedAt = Date.parse(timestamp)
  if (!Number.isFinite(startedAt)) return []
  const content = (message as { content?: unknown } | undefined)?.content
  const texts = Array.isArray(content)
    ? content.map((block) => (block as { text?: unknown })?.text)
    : [content]
  if (!texts.some((text) => typeof text === "string" && interruptions.has(text))) return []
  return [
    {
      type: "turn-ended",
      agent: "claude",
      sessionId,
      instance,
      startedAt,
      outcome: "interrupted",
    },
  ]
}
