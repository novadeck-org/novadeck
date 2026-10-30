import { createHash } from "node:crypto"
import { extname, isAbsolute, relative } from "node:path"

import { absolute, errorText, shortName, sessionId, text } from "@novadeck/harness-core/decode"
import type { BackgroundJob, HarnessEvent, PromptShown } from "@novadeck/harness-core/events"
import type { Report } from "@novadeck/harness-core/report"

import { ended, forget, pending, remember, running, type Base } from "./conversations.js"
import { statusLine } from "./status-line.js"
import { kindOf, toolCall, writers, type ToolCall } from "./tools.js"

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
 * confirmation the status line shows is about (see status-line.ts).
 * What outlives a turn it starts and then wakes the agent with a turn of its own: a
 * `run_command` it backgrounds, and a `schedule` timer. Their PostToolUse fires when they
 * end, not when the turn does, so a call whose PreToolUse has had none by a Stop runs on
 * (see `pending` in conversations.ts).
 */
export const decode = (report: Report): readonly HarnessEvent[] => {
  const events = decodeEvent(report)
  const { seq, instance, payload } = report
  const id = sessionId(payload.conversationId)
  const model = report.event === "StatusLine" ? undefined : modelOf(payload.modelName)
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
const modelOf = (name: unknown): { model: string; effort: string | null } | undefined => {
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
  const base: Base = { agent: "agy", sessionId: id, instance, startedAt: seq }
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
        ...jobs.map(({ id: task, at }): HarnessEvent => ({
          type: "task-started",
          ...base,
          startedAt: at,
          id: task,
          until: null,
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
            tasks: jobs.length,
            ...(payload.fullyIdle === false && { more: true }),
            ...(jobs.length > 0 && {
              jobs: jobs.map(({ id: task, description, command }): BackgroundJob => ({
                id: task,
                description,
                command,
              })),
            }),
          },
        },
      ]
    }
    case "PreToolUse": {
      const call = toolCall(payload.toolCall)
      if (!call) return [observed]
      return [
        observed,
        ...calling(base, call, payload),
        called(base, call),
        ...(typeof payload.stepIdx === "number" ? pending(base, call, payload.stepIdx) : []),
      ]
    }
    case "PostToolUse": {
      const call = toolCall(payload.toolCall)
      return [
        observed,
        ...(typeof payload.stepIdx === "number" ? ended(base, payload.stepIdx) : []),
        ...(call
          ? [
              ...written(base, call, payload),
              ...artifact(base, call, payload),
              ...answered(base, call, payload),
            ]
          : []),
      ]
    }
    default:
      return [observed]
  }
}

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
const calling = (base: Base, call: ToolCall, payload: Report["payload"]): HarnessEvent[] => {
  remember(base.sessionId, call, callId(call, payload))
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
const called = (base: Base, call: ToolCall): HarnessEvent => ({
  type: "tool-called",
  ...base,
  actor: null,
  toolName: call.name,
  kind: kindOf(call.name, call.args),
})

// An ask_question that was answered, or skipped: its PostToolUse.
const answered = (base: Base, call: ToolCall, payload: Report["payload"]): HarnessEvent[] =>
  call.name === "ask_question"
    ? [
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
    : []

// A plan: Markdown the agent writes, in the conversation's own folder, as an artifact
// asking for the person's review; one it failed to write is none.
const artifact = (
  base: Base,
  { name, args }: ToolCall,
  payload: Report["payload"],
): HarnessEvent[] => {
  const metadata = args.ArtifactMetadata as { RequestFeedback?: unknown } | undefined
  if (
    (name !== "write_file" && name !== "write_to_file") ||
    metadata?.RequestFeedback !== true ||
    text(payload.error)
  )
    return []
  const path = absolute(args.Path ?? args.TargetFile)
  const folder = absolute(payload.artifactDirectoryPath)
  if (!path || !folder || extname(path) !== ".md") return []
  const inside = relative(folder, path)
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return []
  return [{ type: "plan-observed", ...base, actor: null, plan: { kind: "file", path } }]
}

// A file it wrote, as its write or edit call names it.
const written = (
  base: Base,
  { name, args }: ToolCall,
  payload: Report["payload"],
): HarnessEvent[] => {
  const path = absolute(args.Path ?? args.TargetFile)
  if (!writers.includes(name) || !path || text(payload.error)) return []
  return [{ type: "file-touched", ...base, actor: null, path }]
}

/**
 * Antigravity's prompt showing before any conversation: a plain start's status line says
 * idle and names none until the first prompt starts one (probed 2026-10-01, 1.2.14).
 */
export const shown = ({ event, seq, instance, payload }: Report): PromptShown | undefined =>
  event === "StatusLine" && payload.agent_state === "idle" && !payload.conversation_id
    ? { type: "prompt-shown", agent: "agy", instance, startedAt: seq }
    : undefined
