import type { ActivityEvent, TelemetryObserved } from "../events.js"
import { callId, type Run } from "../harness.js"

// Claude Code's records of an interrupted turn: Esc while it works or runs a tool, and
// "No" to a permission request, which interrupts the turn too. Only these exact texts
// count, so a prompt that merely starts like one does not.
const marker = "[Request interrupted by user"
const interruptions = new Set([`${marker}]`, `${marker} for tool use]`])

/**
 * The root's tool calls whose results the transcript has yet to record, by their
 * `tool_use` ids: the request each would resolve, and its tool.
 */
export type Calls = Map<string, { readonly requestId: string; readonly toolName: string }>

// Calls whose results never came, as the session ended, are forgotten past this many.
const remembered = 256

// The tool whose request's input differs from the call's, as Claude Code names a plan's
// file itself; an actor shows one plan at a time. A question's request asks it unanswered,
// as the call does, so it matches exactly: its result's hook may have settled it already,
// and a loose match would settle another question still asked.
const loosely: ReadonlySet<string> = new Set(["ExitPlanMode"])

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
 * - A tool call's result came, however its request was settled. A permission prompt that
 *   timed out denies the call and the turn runs on, with no hook (2.1.296), so its result
 *   is all that says the request waits no longer. `calls` keeps each call the transcript
 *   records until its result does.
 *
 * Subagents keep their own transcripts, so every line here is the root agent's.
 */
export const transcriptEvents = (
  line: string,
  { sessionId, instance }: Pick<Run, "sessionId" | "instance">,
  calls: Calls = new Map(),
): readonly (ActivityEvent | TelemetryObserved)[] => {
  // Most lines are long tool results; only these kinds need parsing.
  const interrupting = line.includes(marker)
  const stopped = line.includes('"stop_hook_summary"')
  const called = line.includes('"tool_use"')
  const result = calls.size > 0 && line.includes('"tool_result"')
  if (!interrupting && !stopped && !called && !result && !line.includes('"usage"')) return []
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
  const blocks = (Array.isArray(content) ? content : []) as Record<string, unknown>[]
  if (type === "assistant") remember(calls, blocks)
  const settled = type === "user" ? results(calls, blocks, base) : []
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
  if (type !== "user" || !interrupting) return settled
  const texts = Array.isArray(content)
    ? content.map((block) => (block as { text?: unknown })?.text)
    : [content]
  if (!texts.some((text) => typeof text === "string" && interruptions.has(text))) return settled
  return [...settled, { type: "turn-ended", ...base, outcome: "interrupted" }]
}

// The calls an assistant record makes, each by the id the hooks' request goes by.
const remember = (calls: Calls, blocks: readonly Record<string, unknown>[]): void => {
  for (const { type, id, name, input } of blocks) {
    if (type !== "tool_use" || typeof id !== "string" || typeof name !== "string") continue
    calls.set(id, { requestId: callId(null, name, input), toolName: name })
    if (calls.size > remembered) calls.delete(calls.keys().next().value!)
  }
}

// The requests a user record's tool results settle.
const results = (
  calls: Calls,
  blocks: readonly Record<string, unknown>[],
  base: { agent: "claude"; sessionId: string; instance: string | null; startedAt: number },
): ActivityEvent[] =>
  blocks.flatMap(({ type, tool_use_id: id }) => {
    const call = type === "tool_result" && typeof id === "string" ? calls.get(id) : undefined
    if (!call) return []
    calls.delete(id as string)
    const { requestId, toolName } = call
    return [
      {
        type: "attention-resolved",
        ...base,
        requestId,
        actor: null,
        toolName,
        loose: loosely.has(toolName),
        outcome: "settled",
      },
    ]
  })
