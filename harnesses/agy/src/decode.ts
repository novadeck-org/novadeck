import { createHash } from "node:crypto"
import { extname, isAbsolute, relative } from "node:path"

import type { BackgroundJob, HarnessEvent, PromptShown } from "@novadeck/harness-core/events"
import { absolute, errorText, shortName, sessionId, text } from "@novadeck/harness-core/harness"
import type { Report } from "@novadeck/harness-core/report"
import { oneLine } from "@novadeck/harness-core/tools"

import { kindOf } from "./tools.js"

/**
 * Antigravity's hooks, as normalized facts. Every hook names the conversation it runs in,
 * and nothing says how it began: /clear and /resume switch conversations in one process.
 * PreInvocation starts a model call, so the agent works: the turn's first (its
 * `invocationNum` restarts at 0 each turn) as its prompt, any later one as a call of the
 * turn already running. Stop ends the turn, as failed when it names an error, and says
 * whether background work, as a subagent, still runs (`fullyIdle`). Only a completed turn
 * fires Stop: its confirmations fire no hook, and an Esc or a denial fires nothing. Its
 * status line, which Novadeck's settings hand to the hook as StatusLine, tells both, but
 * reads the same idle after them as after a completed turn: so idle there only ends a
 * turn no Stop ended, and never as completed. It never starts a turn: only PreInvocation
 * starts one. Saying working, it resumes only a turn an older idle of its own ended, never
 * one a Stop ended; showing a confirmation, it asks one only of a turn running, as only a
 * turn asks for one.
 * Every hook names the conversation's transcript. A plan is an artifact it writes asking
 * for the person's review, which its PostToolUse names.
 * PreToolUse, which Novadeck answers "ask" at once, names the call about to run. Its
 * ask_question is a request of its own, as no status line tells that dialog, resolved by
 * its PostToolUse. Any other call may or may not ask the person, as their policy says, so
 * it asks nothing here; the latest of each conversation is only remembered, as the call a
 * confirmation the status line shows is about (see `confirmation`).
 * What outlives a turn it starts and then wakes the agent with a turn of its own: a
 * `run_command` it backgrounds, and a `schedule` timer. Their PostToolUse fires when they
 * end, not when the turn does, so a call whose PreToolUse has had none by a Stop runs on
 * (see `pending`).
 */
export const decode = (report: Report): readonly HarnessEvent[] => {
  const events = decodeEvent(report)
  const { seq, instance, payload } = report
  const id = sessionId(payload.conversationId)
  const model = report.event === "StatusLine" ? undefined : reading(payload.modelName)
  return id && model
    ? [
        ...events,
        {
          type: "telemetry-observed",
          agent: "agy",
          sessionId: id,
          instance,
          startedAt: seq,
          ...model,
        },
      ]
    : events
}

// The reasoning levels Antigravity's model names end in.
const levels: ReadonlySet<string> = new Set(["minimal", "low", "medium", "high", "xhigh"])

/**
 * A hook's model name, with a trailing reasoning level split off as the effort. That the
 * suffix is a level is an inference from the names seen (`gemini-3.8-flash-high`), not
 * something Antigravity documents; any other name is the model whole, with no effort, which
 * clears the last model's.
 */
const reading = (name: unknown): { model: string; effort: string | null } | undefined => {
  const whole = shortName(name, 128)
  if (!whole) return undefined
  const cut = whole.lastIndexOf("-")
  const level = whole.slice(cut + 1)
  return cut > 0 && levels.has(level)
    ? { model: whole.slice(0, cut), effort: level }
    : { model: whole, effort: null }
}

// A quota it ran out of: its error names the API's status RESOURCE_EXHAUSTED, bar a mere
// rate limit's reason (probed 2026-10-15, 1.2.14: the status line of its error is
// "generating and executing: Error 429, Message: ..., Status: RESOURCE_EXHAUSTED, Details: [...]";
// its own wording for a real account's exhausted quota is unverified).
const exhausted = /Status: RESOURCE_EXHAUSTED/
const throttled = /reason:RATE_LIMIT_EXCEEDED/

const failed = (value: unknown): { error?: string; limited?: true } => {
  const error = errorText(value)
  if (error === undefined) return {}
  // Read from the whole text: the cut of it to what is kept may lose the reason.
  const whole = typeof value === "string" ? value : ""
  return {
    error,
    ...(exhausted.test(whole) && !throttled.test(whole) && { limited: true as const }),
  }
}

const decodeEvent = ({ event, seq, instance, payload }: Report): readonly HarnessEvent[] => {
  if (event === "StatusLine") return statusLine({ seq, instance, payload })
  const id = sessionId(payload.conversationId)
  if (!id) return []
  const workspaces = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : []
  const cwd = absolute(workspaces[0])
  const transcript = absolute(payload.transcriptPath)
  const base = { agent: "agy", sessionId: id, instance, startedAt: seq } as const
  const observed: HarnessEvent = {
    type: "session-observed",
    ...base,
    evidence: "conversation-observed",
    ...(cwd !== undefined && { cwd }),
    ...(transcript !== undefined && { transcript }),
  }
  switch (event) {
    case "PreInvocation":
      // A turn begun leaves no call of one before it unended but those a Stop saw.
      if (payload.invocationNum === 0) forget(id)
      return [
        observed,
        // Its first model call starts a turn, whether the person prompted it or a subagent's
        // message woke the agent: no hook tells which.
        { type: "turn-started", ...base, cause: payload.invocationNum === 0 ? "harness" : "call" },
      ]
    case "Stop": {
      const { jobs, wake } = running(id)
      return [
        observed,
        // Each job's start, as its call told it, for the time it has waited since.
        ...jobs.map(({ id: task, at, daemon }): HarnessEvent => ({
          type: "task-started",
          ...base,
          startedAt: at,
          id: task,
          until: null,
          ...(daemon && { persistent: true as const }),
        })),
        // A timer of an earlier turn is still the wake-up of this one.
        ...(wake ? [{ type: "wake-scheduled" as const, ...base, ...wake }] : []),
        {
          type: "turn-ended",
          ...base,
          outcome: text(payload.error) ? "failed" : "completed",
          ...failed(payload.error),
          // It says only that something runs on: its status line, drawn just after,
          // counts the subagents among it, but never a command it backgrounded, whose end
          // wakes it too (probed 2026-10-04, 1.2.14); the calls that never ended, though,
          // are those (probed 2026-10-24, 1.4.6).
          background: {
            agents: 0,
            // A daemon is listed, as persistent, but not counted: it never wakes the agent.
            tasks: jobs.filter(({ daemon }) => !daemon).length,
            ...(payload.fullyIdle === false && { more: true }),
            ...(jobs.length > 0 && {
              jobs: jobs.map(({ id: task, description, command, daemon }): BackgroundJob => ({
                id: task,
                description,
                command,
                ...(daemon && { persistent: true as const, uncounted: true as const }),
              })),
            }),
          },
        },
      ]
    }
    case "PreToolUse":
      return [
        observed,
        ...calling(base, id, payload),
        ...called(base, payload),
        ...pending(base, id, payload),
      ]
    case "PostToolUse":
      return [
        observed,
        ...ended(base, id, payload),
        ...written(base, payload),
        ...artifact(base, payload),
        ...answered(base, payload),
      ]
    default:
      return [observed]
  }
}

type Base = { agent: "agy"; sessionId: string; instance: string | null; startedAt: number }

/** A tool call as a hook names it. */
type ToolCall = { readonly name: string; readonly args: Record<string, unknown> }

const toolCall = (payload: Report["payload"]): ToolCall | undefined => {
  const { name, args } = (payload.toolCall ?? {}) as { name?: unknown; args?: unknown }
  if (typeof name !== "string" || name === "") return undefined
  return {
    name,
    args: typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
  }
}

// The latest call each conversation's PreToolUse named, for as many conversations as it
// has any use for: a confirmation always follows its own call's hook. A confirmation of a
// call this doesn't hold, or that a later call replaced (parallel calls), gets no input,
// and its dialog stays unrecognised.
const latest = new Map<string, { call: ToolCall; id: string }>()
const remembered = 32

// A call's request id: its step, which its PostToolUse names too, or a hash of its input.
const callId = (call: ToolCall, payload: Report["payload"]): string =>
  typeof payload.stepIdx === "number"
    ? `${call.name}:${payload.stepIdx}`
    : `${call.name}:${createHash("sha256").update(JSON.stringify(call.args)).digest("hex").slice(0, 16)}`

// What ask_question's questions are, as its call gives them.
const questionsOf = (call: ToolCall): { question: string; options: string[] }[] =>
  (Array.isArray(call.args.questions) ? call.args.questions : []).flatMap((each: unknown) => {
    const { question, options } = (each ?? {}) as { question?: unknown; options?: unknown }
    return typeof question === "string"
      ? [
          {
            question,
            options: Array.isArray(options)
              ? options.filter((option): option is string => typeof option === "string")
              : [],
          },
        ]
      : []
  })

// A call about to run: remembered as the one a confirmation may be about, and, for
// ask_question, a question the person is asked.
const calling = (base: Base, conversation: string, payload: Report["payload"]): HarnessEvent[] => {
  const call = toolCall(payload)
  if (!call) return []
  latest.delete(conversation)
  latest.set(conversation, { call, id: callId(call, payload) })
  for (const [oldest] of latest) if (latest.size > remembered) latest.delete(oldest)
  if (call.name !== "ask_question") return []
  const [first] = questionsOf(call)
  if (!first) return []
  return [
    {
      type: "attention-requested",
      ...base,
      requestId: callId(call, payload),
      actor: null,
      toolName: call.name,
      kind: "question",
      subject: first.question,
      choices: first.options,
      input: call,
    },
  ]
}

// Every call about to run, reported once; its kind is told by its name and arguments.
const called = (base: Base, payload: Report["payload"]): HarnessEvent[] => {
  const call = toolCall(payload)
  return call
    ? [
        {
          type: "tool-called",
          ...base,
          actor: null,
          toolName: call.name,
          kind: kindOf(call.name, call.args),
        },
      ]
    : []
}

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
 * a daemon, a cron or a timer too long is no wait of the activity's, which judges that, but
 * all hold a place in that count. Told by its PreToolUse, at `at`, and over when its
 * PostToolUse comes, which for these fires when they end (probed 2026-10-24, 1.4.6).
 */
type Pending = {
  readonly id: string
  readonly at: number
  /** Whether it is a command, a job a Stop lists. */
  readonly job: boolean
  /** Whether it runs for good (`IsDaemon`), which no end of its own wakes the agent for. */
  readonly daemon: boolean
  readonly description: string | null
  readonly command: string
  readonly wake: { at: number; reason: string | null } | null
  /** Whether a Stop saw it pending, which proves its turn completed with it backgrounded. */
  seen: boolean
}

// What each conversation's calls await their PostToolUse, for as many conversations as
// `latest` holds, and as many calls in each as the activity takes jobs.
const open = new Map<string, Map<string, Pending>>()
const remembering = 16

// The tasks the latest idle status line of each conversation counted.
const counted = new Map<string, number>()

// The longest timer taken at its word: a day. A longer one sets no wake-up.
const maxTimerSeconds = 86_400

const awaiting = (conversation: string): Map<string, Pending> => {
  const calls = open.get(conversation) ?? new Map<string, Pending>()
  open.delete(conversation)
  open.set(conversation, calls)
  for (const [oldest] of open) if (open.size > remembered) open.delete(oldest)
  return calls
}

// A call over, as the activity learns it.
const over = (base: Base, call: Pending): HarnessEvent => ({
  type: "task-ended",
  ...base,
  id: call.id,
})

// A command it runs for good (`IsDaemon`) is told as a persistent job, as the activity
// judges what is no wait; a cron or a timer that repeats is no job or wake-up at all. The
// rest are told here whether they end in the background or not, by whether their
// PostToolUse comes before the turn's Stop. Killing a
// task names it by an id no hook gives, so it ends every call of the conversation: a wait
// missed beats one that never ends.
const pending = (base: Base, conversation: string, payload: Report["payload"]): HarnessEvent[] => {
  const call = toolCall(payload)
  const { stepIdx } = payload
  if (!call || typeof stepIdx !== "number") return []
  const { name, args } = call
  if (name === "manage_task" && args.Action === "kill") {
    const calls = open.get(conversation)
    const killed = [...(calls?.values() ?? [])].map((each) => over(base, each))
    calls?.clear()
    return killed
  }
  if (name !== "run_command" && name !== "schedule") return []
  const id = `${conversation}:${stepIdx}`
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
  const calls = awaiting(conversation)
  calls.set(id, {
    id,
    at: base.startedAt,
    job: name === "run_command",
    daemon,
    description: said === command.trim() ? null : (said ?? null),
    command,
    wake,
    seen: false,
  })
  for (const [oldest] of calls) if (calls.size > remembering) calls.delete(oldest)
  return wake ? [{ type: "wake-scheduled", ...base, ...wake, id }] : []
}

// What a Stop finds running on: the commands never ended, and the earliest timer.
const running = (
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

// A turn begun without a Stop having ended the one before: that turn was denied or
// stopped, and the calls of it that its last status line did not count never ran on.
const forget = (conversation: string): void => {
  unaccounted(conversation, counted.get(conversation) ?? 0)
}

// A call over: its PostToolUse, which comes at the end of a backgrounded one, so a job done
// is no longer waited on.
const ended = (base: Base, conversation: string, payload: Report["payload"]): HarnessEvent[] => {
  const { stepIdx } = payload
  if (typeof stepIdx !== "number") return []
  const id = `${conversation}:${stepIdx}`
  const call = open.get(conversation)?.get(id)
  if (!call) return []
  open.get(conversation)!.delete(id)
  return [over(base, call)]
}

// What an idle status line shows over: see `unaccounted`.
const abandoned = (base: Base, conversation: string, tasks: number): HarnessEvent[] => {
  counted.delete(conversation)
  counted.set(conversation, tasks)
  for (const [oldest] of counted) if (counted.size > remembered) counted.delete(oldest)
  return unaccounted(conversation, tasks, { before: base.startedAt, seenToo: true }).map((call) =>
    over(base, call),
  )
}

// An ask_question that was answered, or skipped: its PostToolUse.
const answered = (base: Base, payload: Report["payload"]): HarnessEvent[] => {
  const call = toolCall(payload)
  if (call?.name !== "ask_question") return []
  return [
    {
      type: "attention-resolved",
      ...base,
      requestId: callId(call, payload),
      actor: null,
      toolName: call.name,
      loose: false,
      outcome: "allowed",
    },
  ]
}

// A plan: Markdown the agent writes, in the conversation's own folder, as an artifact
// asking for the person's review; one it failed to write is none.
const artifact = (
  base: { agent: "agy"; sessionId: string; instance: string | null; startedAt: number },
  payload: Report["payload"],
): HarnessEvent[] => {
  const { name, args } = (payload.toolCall ?? {}) as {
    name?: unknown
    args?: Record<string, unknown>
  }
  const metadata = args?.ArtifactMetadata as { RequestFeedback?: unknown } | undefined
  if (
    (name !== "write_file" && name !== "write_to_file") ||
    metadata?.RequestFeedback !== true ||
    text(payload.error)
  )
    return []
  const path = absolute(args?.Path ?? args?.TargetFile)
  const folder = absolute(payload.artifactDirectoryPath)
  if (!path || !folder || extname(path) !== ".md") return []
  const inside = relative(folder, path)
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return []
  return [{ type: "plan-observed", ...base, actor: null, plan: { kind: "file", path } }]
}

// The tools that write a file, each naming it in its PostToolUse: write_file and edit_file
// as Path from 1.4 (probed 2026-10-20, 1.4.3), write_to_file and replace_file_content as
// TargetFile before (probed 2026-10-15, 1.2.14 and 1.3.5: replace_file_content is its only
// edit tool; a model is offered no multi_replace_file_content).
const writers: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "write_to_file",
  "replace_file_content",
])

// A file it wrote, as its write or edit call names it.
const written = (
  base: { agent: "agy"; sessionId: string; instance: string | null; startedAt: number },
  payload: Report["payload"],
): HarnessEvent[] => {
  const { name, args } = (payload.toolCall ?? {}) as {
    name?: unknown
    args?: Record<string, unknown>
  }
  const path = absolute(args?.Path ?? args?.TargetFile)
  if (typeof name !== "string" || !writers.has(name) || !path || text(payload.error)) return []
  return [{ type: "file-touched", ...base, actor: null, path }]
}

// Statuses of a subagent that no longer runs.
const finished = new Set(["done", "completed", "finished", "idle", "failed", "cancelled", "error"])

/**
 * How many subagents the status line lists still running. It lists them while they run,
 * and after, as `completed` (probed 2026-10-04, 1.2.14); one that names its state counts
 * only while that is not a finished one.
 */
const subagentsRunning = (subagents: unknown): number =>
  Array.isArray(subagents)
    ? subagents.filter((subagent) => {
        if (typeof subagent !== "object" || subagent === null) return true
        const { status, state } = subagent as { status?: unknown; state?: unknown }
        const named = text(status) ?? text(state)
        return named === undefined || !finished.has(named.toLowerCase())
      }).length
    : 0

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

// How long each of Antigravity's quota windows lasts, by the end of its name.
const windows = { weekly: 10_080, daily: 1440 } as const

// A confirmation is the one request Antigravity shows at a time, and says nothing of.
const confirmation = {
  requestId: "confirmation",
  actor: null,
  toolName: "confirmation",
} as const

/**
 * Antigravity's status line: whether the agent works or waits on the person's
 * confirmation, whether it plans, how full its context window is, and its named quota windows, each with
 * the fraction left and when it resets. It names the person's account too, which nothing
 * here reads. Before a conversation starts it names none. It says idle only once its own
 * prompt shows: "authenticating" and "initializing" before, behind its login screen and
 * its folder-trust dialog too (probed 2026-10-01, 1.2.14), so a conversation it names
 * while idle is one at its prompt.
 */
const statusLine = ({ seq, instance, payload }: Pick<Report, "seq" | "instance" | "payload">) => {
  const id = sessionId(payload.conversation_id)
  if (!id) return []
  const cwd = absolute(payload.cwd)
  const base = { agent: "agy", sessionId: id, instance, startedAt: seq } as const
  const events: HarnessEvent[] = [
    {
      type: "session-observed",
      ...base,
      evidence: "conversation-observed",
      ...(cwd !== undefined && { cwd }),
      root: true,
      ...(payload.agent_state === "idle" && { atPrompt: true }),
    },
    // Its mode, which it names only while not the default, and reruns on when it changes.
    { type: "mode-observed", ...base, planning: payload.cycle_mode === "plan" },
  ]
  // Idle reads the same after a completed turn, an Esc and a denial: it ends a turn its
  // Stop did not, as abnormally. Working never starts a turn, as its hook may run 10 to
  // 60 ms after the turn's Stop and still say working (probed 2026-10-02, 1.2.14): only
  // PreInvocation starts one. It resumes only a turn an older idle snapshot ended, as an
  // idle one may be stale too, never one a Stop ended. A confirmation it shows counts only
  // while a turn runs (`midTurn`), as Antigravity asks one only mid-turn, before its Stop:
  // one drawn just after the Stop asks nothing. Working without a confirmation settles one
  // the turn waited on. A snapshot's hook may start after the next turn's, so none of
  // these holds for long against a wrong one.
  const working = payload.agent_state === "working" || payload.agent_state === "tool_use"
  // It lists its subagents while the turn runs too, so a working snapshot tells how many
  // run, by status and not position, as the list's order flips (probed 2026-10-07, 1.2.16).
  if (working)
    events.push({ type: "turn-working", ...base, running: subagentsRunning(payload.subagents) })
  if (payload.agent_state === "idle")
    events.push({
      type: "turn-idle",
      ...base,
      background: { agents: subagentsRunning(payload.subagents), tasks: 0 },
    })
  else if (payload.tool_confirmation_pending === true)
    events.push({
      type: "attention-requested",
      ...base,
      ...confirmation,
      // One request per call it is about, so back-to-back confirmations are distinct.
      ...(latest.has(id) && { requestId: `confirmation:${latest.get(id)!.id}` }),
      kind: "permission",
      subject: null,
      choices: [],
      // The call its conversation's latest PreToolUse named: the status line names none.
      ...(latest.has(id) && { input: latest.get(id)!.call }),
      midTurn: true,
    })
  else if (working)
    events.push({
      type: "attention-resolved",
      ...base,
      ...confirmation,
      // Whichever call's, as the status line names none: the actor's oldest.
      loose: true,
      outcome: "allowed",
    })
  // Its count of background tasks, which it drops once none runs. A call that never
  // ended, though no task runs, was denied or stopped, and fires no PostToolUse; with
  // tasks running, so is one that no Stop saw and the count cannot account for.
  if (payload.agent_state === "idle")
    events.push(...abandoned(base, id, count(payload.task_count) ?? 0))
  const window = (payload.context_window ?? {}) as Record<string, unknown>
  const capacity = count(window.context_window_size)
  const percent = count(window.used_percentage)
  const quota = payload.quota
  const limits =
    typeof quota === "object" && quota !== null
      ? Object.entries(quota as Record<string, unknown>).flatMap(([name, value]) => {
          const { remaining_fraction: left, reset_time: resets } = (value ?? {}) as Record<
            string,
            unknown
          >
          const fraction = count(left)
          if (fraction === undefined) return []
          const at = typeof resets === "string" ? Date.parse(resets) : Number.NaN
          const minutes = Object.entries(windows).find(([end]) => name.endsWith(end))?.[1] ?? null
          return [
            {
              minutes,
              used: Math.max(0, 1 - Math.min(1, fraction)),
              resetsAt: Number.isNaN(at) ? null : at,
            },
          ]
        })
      : undefined
  events.push({
    type: "telemetry-observed",
    ...base,
    // Its share of the window, as it reports it: its token counts come only once a turn
    // is over.
    ...(capacity !== undefined &&
      capacity >= 1 &&
      percent !== undefined && {
        context: {
          occupied: Math.round((capacity * Math.min(100, percent)) / 100),
          capacity: Math.round(capacity),
        },
      }),
    ...(limits !== undefined && { limits: limits.slice(0, 8) }),
  })
  return events
}

/**
 * Antigravity's prompt showing before any conversation: a plain start's status line says
 * idle and names none until the first prompt starts one (probed 2026-10-01, 1.2.14).
 */
export const shown = ({ event, seq, instance, payload }: Report): PromptShown | undefined =>
  event === "StatusLine" && payload.agent_state === "idle" && !payload.conversation_id
    ? { type: "prompt-shown", agent: "agy", instance, startedAt: seq }
    : undefined
