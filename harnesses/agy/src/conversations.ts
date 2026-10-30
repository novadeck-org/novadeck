import { errorText } from "@novadeck/harness-core/decode"
import type { HarnessEvent } from "@novadeck/harness-core/events"
import { oneLine } from "@novadeck/harness-core/tools"

import type { ToolCall } from "./tools.js"

/**
 * What the decoder holds of each conversation's tool calls from one hook to the next: the
 * latest call, which a confirmation its status line shows is about, and the calls that may
 * outlive their turn, which a Stop lists and a later hook ends.
 */

/** What every event of one report shares. */
export type Base = { agent: "agy"; sessionId: string; instance: string | null; startedAt: number }

// How many conversations each memory holds, and how many awaited calls it holds of each:
// as many as the activity takes jobs.
const maxConversations = 32
const maxCalls = 16

// Drops the oldest of `map` while it holds more than `limit`.
const trim = <K, V>(map: Map<K, V>, limit: number): void => {
  for (const [oldest] of map) if (map.size > limit) map.delete(oldest)
}

// Puts `value` in `map` as its newest, keeping the newest `maxConversations`.
const keep = <K, V>(map: Map<K, V>, key: K, value: V): V => {
  map.delete(key)
  map.set(key, value)
  trim(map, maxConversations)
  return value
}

// The latest call each conversation's PreToolUse named: a confirmation always follows its
// own call's hook. A confirmation of a call this doesn't hold, or that a later call
// replaced (parallel calls), gets no input, and its dialog stays unrecognised.
const latest = new Map<string, { call: ToolCall; id: string }>()

/** Remembers `call`, with its request id, as the latest of its conversation. */
export const remember = (conversation: string, call: ToolCall, id: string): void => {
  keep(latest, conversation, { call, id })
}

/** The latest call of a conversation, as the one a confirmation is about. */
export const latestOf = (conversation: string): { call: ToolCall; id: string } | undefined =>
  latest.get(conversation)

// How much of a job's description the protocol takes.
const maxDescription = 512

// The first line of what the agent wrote, sanitized and cut to what the protocol takes;
// undefined if blank.
const firstLine = (value: unknown): string | undefined => {
  const line = oneLine(errorText(value) ?? "").slice(0, maxDescription)
  return line === "" ? undefined : line
}

/**
 * A call that may outlive its turn, and that Antigravity counts a background task while it
 * does: a command, with the agent's words for it, or a timer, with the wake-up it sets;
 * a daemon, a cron or a timer too long is neither, as none ends by itself or sets a
 * wake-up, but all hold a place in that count. Told by its PreToolUse, at `at`, and over
 * when its PostToolUse comes, which for these fires when they end (probed 2026-10-24, 1.4.6).
 */
type Pending = {
  readonly id: string
  readonly at: number
  /** Whether it is a command that ends by itself, as a job the agent waits on. */
  readonly job: boolean
  readonly description: string | null
  readonly command: string
  readonly wake: { at: number; reason: string | null } | null
  /** Whether a Stop saw it pending, which proves its turn completed with it backgrounded. */
  seen: boolean
}

// What each conversation's calls await their PostToolUse.
const open = new Map<string, Map<string, Pending>>()

// The tasks the latest idle status line of each conversation counted.
const counted = new Map<string, number>()

// The longest timer taken at its word: a day. A longer one sets no wake-up.
const maxTimerSeconds = 86_400

// A call over, as the activity learns it.
const over = (base: Base, call: Pending): HarnessEvent => ({
  type: "task-ended",
  ...base,
  id: call.id,
})

/**
 * A call about to run that may outlive its turn, from its PreToolUse at step `step`. A
 * command it runs for good (`IsDaemon`) is left out of the jobs a Stop lists, as it
 * declares it runs for ever, as Claude Code leaves subagents out of its jobs; a cron or a
 * timer that repeats is no job or wake-up either. The rest are told here whether they end
 * in the background or not, by whether their PostToolUse comes before the turn's Stop.
 * Killing a task names it by an id no hook gives, so it ends every call of the
 * conversation: a wait missed beats one that never ends.
 */
export const pending = (base: Base, call: ToolCall, step: number): HarnessEvent[] => {
  const conversation = base.sessionId
  const { name, args } = call
  if (name === "manage_task" && args.Action === "kill") {
    const calls = open.get(conversation)
    const killed = [...(calls?.values() ?? [])].map((each) => over(base, each))
    calls?.clear()
    return killed
  }
  if (name !== "run_command" && name !== "schedule") return []
  const id = `${conversation}:${step}`
  const daemon = args.IsDaemon === true
  const seconds = args.DurationSeconds
  const wake =
    name === "schedule" &&
    !daemon &&
    typeof seconds === "number" &&
    seconds > 0 &&
    seconds <= maxTimerSeconds &&
    !("CronExpression" in args)
      ? { at: base.startedAt + seconds * 1000, reason: firstLine(args.Prompt) ?? null }
      : null
  const command = errorText(args.CommandLine) ?? ""
  const said = firstLine(args.toolSummary)
  const calls = keep(open, conversation, open.get(conversation) ?? new Map<string, Pending>())
  calls.set(id, {
    id,
    at: base.startedAt,
    job: name === "run_command" && !daemon,
    description: said === command.trim() ? null : (said ?? null),
    command,
    wake,
    seen: false,
  })
  trim(calls, maxCalls)
  return wake ? [{ type: "wake-scheduled", ...base, ...wake, id }] : []
}

/** What a Stop finds running on: the commands never ended, and the earliest timer. */
export const running = (
  conversation: string,
): {
  jobs: Pending[]
  wake: { at: number; reason: string | null; id: string } | undefined
} => {
  const calls = [...(open.get(conversation)?.values() ?? [])]
  // A Stop proves its turn completed, so these outlive it.
  for (const call of calls) call.seen = true
  const timers = calls.filter(({ wake }) => wake).toSorted((a, b) => a.wake!.at - b.wake!.at)
  return {
    jobs: calls.filter(({ job }) => job),
    wake: timers[0] && { ...timers[0].wake!, id: timers[0].id },
  }
}

/**
 * The calls no running task accounts for, and so none that a denial or an Escape ended,
 * which fires no PostToolUse: the status line counts `tasks`, the calls a Stop saw take
 * their places, and the unseen ones, oldest first, the rest. A turn ends on its last call,
 * so the newest go. Where it counts none, every call is over, seen or not (`seenToo`).
 */
const unaccounted = (
  conversation: string,
  tasks: number,
  { before = Infinity, seenToo = false } = {},
): Pending[] => {
  const calls = [...(open.get(conversation)?.values() ?? [])]
  const dropped =
    seenToo && tasks === 0
      ? calls.filter(({ at }) => at <= before)
      : calls
          .filter(({ at, seen }) => !seen && at <= before)
          .slice(Math.max(0, tasks - calls.filter(({ seen }) => seen).length))
  for (const { id } of dropped) open.get(conversation)!.delete(id)
  return dropped
}

/**
 * A turn begun without a Stop having ended the one before: that turn was denied or
 * stopped, and the calls of it that its last status line did not count never ran on.
 */
export const forget = (conversation: string): void => {
  unaccounted(conversation, counted.get(conversation) ?? 0)
}

/**
 * A call over: its PostToolUse at step `step`, which comes at the end of a backgrounded
 * one, so a job done is no longer waited on.
 */
export const ended = (base: Base, step: number): HarnessEvent[] => {
  const calls = open.get(base.sessionId)
  const id = `${base.sessionId}:${step}`
  const call = calls?.get(id)
  if (!calls || !call) return []
  calls.delete(id)
  return [over(base, call)]
}

/** What an idle status line counting `tasks` shows over: see `unaccounted`. */
export const abandoned = (base: Base, tasks: number): HarnessEvent[] => {
  keep(counted, base.sessionId, tasks)
  return unaccounted(base.sessionId, tasks, { before: base.startedAt, seenToo: true }).map((call) =>
    over(base, call),
  )
}
