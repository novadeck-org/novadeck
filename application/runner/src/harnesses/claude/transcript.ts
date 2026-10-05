import type { ActivityEvent, TelemetryObserved } from "../events.js"
import type { Run } from "../harness.js"

// Claude Code's records of an interrupted turn: Esc while it works or runs a tool, and
// "No" to a permission request, which interrupts the turn too. Only these exact texts
// count, so a prompt that merely starts like one does not.
const marker = "[Request interrupted by user"
const interruptions = new Set([`${marker}]`, `${marker} for tool use]`])

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0

/**
 * What one line of Claude Code's session transcript says that its hooks do not.
 *
 * - The person interrupted the turn. No hook fires for Esc or for a denied request, but
 *   the transcript records the interruption, which ends the turn and settles its requests.
 * - The turn's Stop hooks ran: Claude Code records a `stop_hook_summary` once they have
 *   (2.1.289), however Novadeck's own fared, so the turn ends `recorded` should that
 *   hook's report never have come. It says nothing of what still runs in the background.
 * - How full the context is: each assistant record carries the usage of its request, whose
 *   input, cache writes and cache reads are what the context holds. The transcript does
 *   not say the model's capacity.
 *
 * Subagents keep their own transcripts, so every line here is the root agent's.
 */
export const transcriptEvents = (
  line: string,
  { sessionId, instance }: Pick<Run, "sessionId" | "instance">,
): readonly (ActivityEvent | TelemetryObserved)[] => {
  // Most lines are long tool results; only these three kinds need parsing.
  const interrupting = line.includes(marker)
  const stopped = line.includes('"stop_hook_summary"')
  if (!interrupting && !stopped && !line.includes('"usage"')) return []
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return []
  }
  if (typeof record !== "object" || record === null) return []
  const { type, subtype, isSidechain, timestamp, message } = record as Record<string, unknown>
  if (isSidechain === true || typeof timestamp !== "string") return []
  const startedAt = Date.parse(timestamp)
  if (!Number.isFinite(startedAt)) return []
  const base = { agent: "claude", sessionId, instance, startedAt } as const
  if (type === "system" && subtype === "stop_hook_summary")
    return [{ type: "turn-ended", ...base, outcome: "completed", recorded: true }]
  const { content, usage } = (message ?? {}) as { content?: unknown; usage?: unknown }
  if (type === "assistant" && typeof usage === "object" && usage !== null) {
    const {
      input_tokens: input,
      cache_creation_input_tokens: written,
      cache_read_input_tokens: read,
    } = usage as Record<string, unknown>
    const occupied = Math.round(count(input) + count(written) + count(read))
    return occupied > 0
      ? [{ type: "telemetry-observed", ...base, context: { occupied, capacity: null } }]
      : []
  }
  if (type !== "user" || !interrupting) return []
  const texts = Array.isArray(content)
    ? content.map((block) => (block as { text?: unknown })?.text)
    : [content]
  if (!texts.some((text) => typeof text === "string" && interruptions.has(text))) return []
  return [{ type: "turn-ended", ...base, outcome: "interrupted" }]
}
