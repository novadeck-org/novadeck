import { callId, versionName } from "@novadeck/harness-core/decode"
import type { ActivityEvent, EventBase, TelemetryObserved } from "@novadeck/harness-core/events"
import { parseFields } from "@novadeck/harness-core/fields"
import { followLines } from "@novadeck/harness-core/follow"
import type { Harness, Run, WrittenPlan } from "@novadeck/harness-core/harness"
import { at } from "@novadeck/harness-core/items"

import { presentedPlan, shellOutputs, shellsEnded } from "./decode.js"
import { interruptions, mentionsInterruption } from "./interruption.js"
import { transcripts } from "./transcripts.js"

/**
 * What Claude Code's session transcript says beside its hooks: followed live while a
 * session is bound (`followTranscript`, the harness's `watch`), and read back for the plans
 * it presented (`transcriptPlans`). `transcripts.ts` reads the same files for the chat.
 */

/**
 * An agent's tool calls whose results its transcript has yet to record, by their
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

// A count of tokens a usage gives, or none.
const tokens = (value: unknown): number =>
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
  const interrupting = mentionsInterruption(line)
  const stopped = line.includes('"stop_hook_summary"')
  const called = line.includes('"tool_use"')
  const result = calls.size > 0 && line.includes('"tool_result"')
  const queued = line.includes('"queue-operation"') && line.includes("<task-notification>")
  const output = line.includes("Output is being written to") || line.includes("<output-file>")
  if (
    !interrupting &&
    !stopped &&
    !called &&
    !result &&
    !queued &&
    !output &&
    !line.includes('"usage"')
  )
    return []
  const fields = parseFields(line)
  if (!fields) return []
  const { type, subtype, isSidechain, timestamp, message } = fields
  if (isSidechain === true || typeof timestamp !== "string") return []
  const startedAt = Date.parse(timestamp)
  if (!Number.isFinite(startedAt)) return []
  const base: EventBase<"claude"> = { agent: "claude", sessionId, instance, startedAt }
  // A background task's notice is queued the moment it ends, though the turn it starts
  // may be later: a shell that ended mid-turn, whose prompt hook comes only after (probed
  // 2026-11-10, 2.1.316).
  if (type === "queue-operation" && fields.operation === "enqueue")
    return typeof fields.content === "string"
      ? [...shellOutputs(base, fields.content), ...shellsEnded(base, fields.content)]
      : []
  if (type === "system" && subtype === "stop_hook_summary")
    return [{ type: "turn-ended", ...base, outcome: "completed", recorded: true }]
  const { content, usage } = (message ?? {}) as { content?: unknown; usage?: unknown }
  const blocks = (Array.isArray(content) ? content : []) as Record<string, unknown>[]
  if (type === "assistant") remember(calls, blocks, null)
  const settled =
    type === "user"
      ? [
          ...results(calls, blocks, base, null),
          ...(output ? textsOf(content).flatMap((text) => shellOutputs(base, text)) : []),
        ]
      : []
  if (type === "assistant" && typeof usage === "object" && usage !== null) {
    const {
      input_tokens: input,
      cache_creation_input_tokens: written,
      cache_read_input_tokens: read,
    } = usage as Record<string, unknown>
    const occupied = Math.round(tokens(input) + tokens(written) + tokens(read))
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

// The text a record's content holds: a prompt's string, and the text blocks of a message,
// including those a tool result holds as a string or as blocks of its own.
const textsOf = (content: unknown): string[] => {
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap((block: { type?: unknown; text?: unknown; content?: unknown }) =>
    block?.type === "text" && typeof block.text === "string"
      ? [block.text]
      : block?.type === "tool_result"
        ? textsOf(block.content)
        : [],
  )
}

// The calls an actor's assistant record makes, each by the id its hooks' request goes by.
const remember = (
  calls: Calls,
  blocks: readonly Record<string, unknown>[],
  actor: string | null,
): void => {
  for (const { type, id, name, input } of blocks) {
    if (type !== "tool_use" || typeof id !== "string" || typeof name !== "string") continue
    calls.set(id, { requestId: callId(actor, name, input), toolName: name })
    if (calls.size > remembered) calls.delete(calls.keys().next().value!)
  }
}

// The requests an actor's user record's tool results settle.
const results = (
  calls: Calls,
  blocks: readonly Record<string, unknown>[],
  base: EventBase<"claude">,
  actor: string | null,
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
        actor,
        toolName,
        loose: loosely.has(toolName),
        outcome: "settled",
      },
    ]
  })

// Claude Code closes every record about the conversation with the same keys, after its
// content (`…,"cwd":…,"sessionId":…,"version":"2.1.316","gitBranch":"HEAD"}`, 2.1.316), so a
// long line is read at its tail, not parsed: `version` followed only by plain top-level
// values to the line's end, which a key of the record's content is not.
const versionReach = 600
const closing =
  /"version":"([^"\\]{1,40})"(?:,"[^"\\]+":(?:"[^"\\]*"|-?[\d.]+|true|false|null))*\}\s*$/

/**
 * The version of Claude Code that wrote a transcript line: its closing `version` key, which
 * the records about the conversation have (user, assistant, attachment, system) and its
 * bookkeeping ones (`mode`, `permission-mode`, `file-history-snapshot`, `last-prompt`…) do
 * not. Undefined for a line without one.
 */
export const transcriptVersion = (line: string): string | undefined =>
  versionName(closing.exec(line.slice(-versionReach))?.[1])

/**
 * Follows a bound session's transcript for what no hook reports: an interrupted turn, and
 * a request a timed-out prompt denied; and for the version of Claude Code writing it, told
 * when it first shows and whenever it changes (a session resumed by a newer release).
 */
export const followTranscript: NonNullable<Harness["watch"]> = async (run, signal, emit) => {
  const calls: Calls = new Map()
  let version: string | undefined
  // Where the session writes it, which a resume in another folder doesn't report.
  const path = await transcripts.locate(run.transcript, run.sessionId, null)
  return followLines(path ?? run.transcript, signal, (line) => {
    const written = transcriptVersion(line)
    if (written !== undefined && written !== version) {
      version = written
      emit({
        type: "telemetry-observed",
        agent: "claude",
        sessionId: run.sessionId,
        instance: run.instance,
        startedAt: Date.now(),
        version,
      })
    }
    for (const event of transcriptEvents(line, run, calls)) emit(event)
  })
}

// The calls a line's tool results name, as Claude Code writes them, unspaced.
const resultIds = /"tool_use_id":"([^"\\]+)"/g

/**
 * What one line of a subagent's own transcript (`<session>/subagents/agent-<id>.jsonl`)
 * says that no hook does: a tool call's result came. The person denying its request, with
 * Esc or its "No", or its prompt timing out, fires no hook, and the subagent runs on, so
 * its result is all that says the request waits no longer (probed 2026-10-03, 2.1.287;
 * fixture `subagent.probe.json`, 2.1.314). Every line of that file is the subagent's
 * (`isSidechain`); only a result from `since` on, when its oldest request still waiting was
 * asked, is told, though every call is remembered, and settled, from the file's start.
 */
export const subagentEvents = (
  line: string,
  { sessionId, instance }: Pick<Run, "sessionId" | "instance">,
  actor: string,
  since: number,
  calls: Calls,
): readonly ActivityEvent[] => {
  // A tool's result, often long, is parsed only where it names a call still unpaired.
  const called = line.includes('"tool_use"')
  const pairs = () => [...line.matchAll(resultIds)].some(([, id]) => calls.has(id!))
  if (!called && !(calls.size > 0 && line.includes('"tool_result"') && pairs())) return []
  const fields = parseFields(line)
  if (!fields || typeof fields.timestamp !== "string") return []
  const startedAt = Date.parse(fields.timestamp)
  if (!Number.isFinite(startedAt)) return []
  const content = (fields.message as { content?: unknown } | undefined)?.content
  const blocks = (Array.isArray(content) ? content : []) as Record<string, unknown>[]
  if (fields.type === "assistant") remember(calls, blocks, actor)
  if (fields.type !== "user") return []
  const base: EventBase<"claude"> = { agent: "claude", sessionId, instance, startedAt }
  const settled = results(calls, blocks, base, actor)
  return startedAt < since ? [] : settled
}

/**
 * Follows a subagent's own transcript, from its start, for its calls' results from `since`
 * on: Novadeck follows it while that subagent's request waits. Claude Code may write the
 * file after the hook that asks, so it is read once it appears.
 */
export const followSubagent: NonNullable<Harness["watchActor"]> = async (
  run,
  actor,
  since,
  signal,
  emit,
) => {
  const path = await transcripts.locate(run.transcript, run.sessionId, actor)
  if (!path || signal.aborted) return
  const calls: Calls = new Map()
  await followLines(
    path,
    signal,
    (line) => {
      for (const event of subagentEvents(line, run, actor, since, calls)) emit(event)
    },
    { fromStart: true },
  )
}

/**
 * The plans a transcript line presents for review, as its hooks would name them: what
 * reads back a plan presented as text, which no file holds, from its actor's transcript.
 */
export const transcriptPlans = (line: string): readonly WrittenPlan[] => {
  if (!line.includes('"ExitPlanMode"')) return []
  const fields = parseFields(line)
  if (fields?.type !== "assistant") return []
  const time = at(fields.timestamp)
  const content = (fields.message as { content?: unknown } | undefined)?.content
  return (Array.isArray(content) ? content : []).flatMap((part) => {
    const { type, name, input } = (part ?? {}) as Record<string, unknown>
    if (type !== "tool_use" || typeof name !== "string") return []
    const plan = presentedPlan(name, input)
    return plan ? [{ source: plan, at: time }] : []
  })
}
