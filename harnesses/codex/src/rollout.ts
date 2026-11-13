import { setTimeout as sleep } from "node:timers/promises"

import {
  absolute,
  planText,
  errorText,
  callId,
  shortName,
  replied,
  versionName,
} from "@novadeck/harness-core/decode"
import type { EventBase, HarnessEvent } from "@novadeck/harness-core/events"
import { isFields, parseFields, type Fields } from "@novadeck/harness-core/fields"
import { followLines } from "@novadeck/harness-core/follow"
import type { Harness, Run, WrittenPlan } from "@novadeck/harness-core/harness"
import { agentLimits, telemetryLimits, type AgentTelemetry } from "@novadeck/protocol"

import { callOf } from "./decode.js"
import { commandRanIn, mcpTool, scriptOf } from "./tools.js"
import { transcripts } from "./transcripts.js"

// A failed turn's `task_complete` error: its message, and `codex_error_info`, which is
// "usage_limit_exceeded" for a usage limit (a rollout of 2026-10-15, codex 0.16x).
const errored = (error: unknown): { error?: string; limited?: true } => {
  const { message, codex_error_info: info } = (
    typeof error === "object" && error !== null ? error : { message: error }
  ) as { message?: unknown; codex_error_info?: unknown }
  const text = errorText(message)
  return {
    ...(text && { error: text }),
    ...(info === "usage_limit_exceeded" && { limited: true as const }),
  }
}

type Limit = AgentTelemetry["limits"][number]

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

// A rate-limit window as Codex reports it: the percentage used, the window's length in
// minutes, and when it resets in epoch seconds.
const limit = (window: unknown): Limit | undefined => {
  if (!isFields(window)) return undefined
  const { used_percent: percent, window_minutes: minutes, resets_at: resets } = window
  const used = number(percent)
  if (used === undefined) return undefined
  const length = number(minutes)
  const at = number(resets)
  return {
    minutes: length !== undefined && length >= 1 ? Math.round(length) : null,
    used: Math.min(1, Math.max(0, used / 100)),
    resetsAt: at !== undefined ? at * 1000 : null,
  }
}

/**
 * What one line of Codex's rollout says that its hooks do not: its `token_count` events
 * carry the latest response's usage with the model's context window, and the account's
 * rate-limit windows; each turn's `task_started` names its collaboration mode, `plan` in
 * Plan Mode, whose hooks still say `default`; a Plan item is the plan it proposes; and
 * each turn's end, by the turn's id: `task_complete`, with an `error` where it failed,
 * which fires no hook (0.159.3), or `turn_aborted`. Those end the turn `recorded`, should
 * its hook's report never come. Codex may write a turn's records long after the turn
 * (the failed turns before a session's first good one came together), so only its id
 * says which turn ended. Each turn's `turn_context` names its `model` and reasoning
 * `effort`. An MCP tool call's item completes however its approval went: one the person
 * cancelled fires no hook, and the turn runs on (0.159.3), so its item settles its request.
 */
export const rolloutEvents = (
  line: string,
  { sessionId, instance }: Pick<Run, "sessionId" | "instance">,
  commands: Commands = new Map(),
): readonly HarnessEvent[] => {
  // A response item is read only for a command's call and for a result that says it goes on:
  // most are long outputs.
  if (
    !/"(session_meta|token_count|task_started|item_completed|task_complete|turn_aborted|turn_context)"/.test(
      line,
    ) &&
    !line.includes('"function_call"') &&
    !line.includes("Process running with session ID")
  )
    return []
  const { type, timestamp, payload } = parseFields(line) ?? {}
  if (typeof timestamp !== "string") return []
  const fields = (payload ?? {}) as Fields
  const startedAt = Date.parse(timestamp)
  if (!Number.isFinite(startedAt)) return []
  const base: EventBase<"codex"> = { agent: "codex", sessionId, instance, startedAt }
  if (type === "response_item") return shellStarted(base, fields, commands)
  // The rollout's first record names the release that wrote it (a session resumed by a
  // newer release adds none, probed 2026-11-03, 0.165.0 then 0.166.0). A record of another
  // thread, as a fork's or a subagent's parent, is not this session's.
  if (type === "session_meta") {
    if (fields.id !== undefined && fields.id !== sessionId) return []
    const version = versionName(fields.cli_version)
    return version !== undefined
      ? [{ type: "telemetry-observed", ...base, version, created: true }]
      : []
  }
  if (type === "turn_context") {
    const { model, effort } = fields
    // A turn that names its model names its effort too, none clearing the last model's.
    const level = shortName(effort, telemetryLimits.effort) ?? null
    const name = shortName(model, telemetryLimits.model)
    const named = {
      ...(name && { model: name, effort: level }),
      ...(level !== null && { effort: level }),
    }
    return Object.keys(named).length > 0 ? [{ type: "telemetry-observed", ...base, ...named }] : []
  }
  if (type !== "event_msg") return []
  switch (fields.type) {
    case "token_count":
      return [telemetry(base, fields)]
    case "task_started":
      return typeof fields.collaboration_mode_kind === "string"
        ? [{ type: "mode-observed", ...base, planning: fields.collaboration_mode_kind === "plan" }]
        : []
    case "task_complete":
    case "turn_aborted": {
      const turn = typeof fields.turn_id === "string" ? fields.turn_id : undefined
      const failed =
        fields.type === "task_complete" && fields.error !== undefined && fields.error !== null
      const outcome =
        fields.type === "turn_aborted" ? "interrupted" : failed ? "failed" : "completed"
      return [
        {
          type: "turn-ended",
          ...base,
          outcome,
          recorded: true,
          ...(turn && { turn }),
          ...replied(fields.last_agent_message),
          ...(failed && errored(fields.error)),
        },
      ]
    }
    case "item_completed": {
      const {
        type: kind,
        text,
        status,
        changes,
        command,
        cwd,
        source,
      } = (fields.item ?? {}) as {
        type?: unknown
        text?: unknown
        status?: unknown
        changes?: unknown
        command?: unknown
        cwd?: unknown
        source?: unknown
      }
      if (kind === "McpToolCall") return mcpSettled(base, null, fields.item as Fields)
      // A command the agent ran, in its own folder, which its hook doesn't name (probed
      // 2026-10-31, 0.163.0: `workdir` reaches the rollout's `cwd`, never the hook); the
      // person's own `!` command is theirs.
      if (kind === "CommandExecution") {
        const folder = source === "user_shell" ? undefined : commandRanIn(command, cwd)
        return [
          ...(folder === undefined ? [] : [{ type: "command-ran" as const, ...base, folder }]),
          ...commandSettled(base, null, fields.item as Fields),
          ...shellEnded(base, fields.item as Fields),
        ]
      }
      // Files a patch changed, by absolute path, however it ran: its PostToolUse comes for
      // the apply_patch tool alone, and none for a patch the model ran through its shell
      // (`apply_patch <<EOF`; probed 2026-10-15, 0.159.3, which the fake model does).
      if (kind === "FileChange")
        return status === "completed" && typeof changes === "object" && changes !== null
          ? Object.keys(changes).flatMap((file) => {
              const path = absolute(file)
              return path
                ? [
                    {
                      type: "file-touched" as const,
                      ...base,
                      actor: null,
                      path,
                      settles: true as const,
                    },
                  ]
                : []
            })
          : []
      if (kind !== "Plan" || typeof text !== "string" || !text) return []
      const { text: plan, truncated } = planText(text)
      return [
        {
          type: "plan-observed",
          ...base,
          actor: null,
          plan: { kind: "text", text: plan, truncated },
        },
      ]
    }
    default:
      return []
  }
}

/**
 * The commands the agent's exec_command calls ran, by call id, until their output says they
 * went to the background, with when each was called.
 */
export type Commands = Map<string, { readonly command: string; readonly at: number }>

// How many calls are remembered unanswered.
const remembered = 64

// What a command's result says when it outlives its yield (probed 2026-11-10, 0.167.0): the
// session that goes on running it, which the item that ends it names as its `process_id`.
const backgrounded = /(?:^|\n)Process running with session ID (\d{1,20})\n/

/**
 * The background shell a response item tells of (probed 2026-11-10, 0.167.0): an exec_command
 * call remembers its command, and its output, if it says "Process running with session
 * ID N", starts the shell by that session id, at the time of the call. The item that ends it
 * comes much later (`shellEnded`); nothing between tells how it runs.
 */
const shellStarted = (
  base: EventBase<"codex">,
  { type, name, arguments: input, call_id: call, output }: Fields,
  commands: Commands,
): HarnessEvent[] => {
  if (typeof call !== "string") return []
  if (type === "function_call" && name === "exec_command" && typeof input === "string") {
    const { cmd } = parseFields(input) ?? {}
    const command = errorText(cmd)
    if (command !== undefined) {
      commands.set(call, { command, at: base.startedAt })
      while (commands.size > remembered) commands.delete(commands.keys().next().value!)
    }
    return []
  }
  if (type !== "function_call_output" || typeof output !== "string") return []
  const session = shortName(backgrounded.exec(output)?.[1], agentLimits.name)
  const called = commands.get(call)
  if (session === undefined || !called) return []
  commands.delete(call)
  return [
    { type: "shell-started", ...base, startedAt: called.at, id: session, command: called.command },
  ]
}

/**
 * The end of a background shell: its CommandExecution item, which names its session as its
 * `process_id` and carries its `exit_code`, -1 when the person stopped it with /stop (no
 * code of the command's own). An item of a command that never went to the background names
 * no shell the activity knows.
 */
const shellEnded = (base: EventBase<"codex">, item: Fields): HarnessEvent[] => {
  const id = shortName(item.process_id, agentLimits.name)
  if (id === undefined) return []
  const code = item.exit_code
  return [
    {
      type: "shell-ended",
      ...base,
      id,
      code: typeof code === "number" && Number.isInteger(code) && code !== -1 ? code : null,
    },
  ]
}

// A yielded exec_command fires no PostToolUse even once it exits (probed 0.167.2,
// code mode with auto review). Its completed item settles only that actor's exact Bash
// request; a user shell command or a command still waiting for approval says nothing.
const commandSettled = (
  base: EventBase<"codex">,
  actor: string | null,
  { command, source, status }: Fields,
): HarnessEvent[] => {
  if (
    source === "user_shell" ||
    (status !== "completed" && status !== "failed") ||
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((word) => typeof word === "string")
  )
    return []
  const script = scriptOf({ command })
  if (script === "") return []
  return [
    {
      type: "attention-resolved",
      ...base,
      requestId: callId(actor, "Bash", { command: script }),
      actor,
      toolName: "Bash",
      loose: false,
      outcome: "settled",
    },
  ]
}

// The request an MCP tool call's completed item settles, by the tool its hooks name and
// the actor whose call it is: the root's, or a subagent's in its own rollout.
const mcpSettled = (
  base: EventBase<"codex">,
  actor: string | null,
  { server, tool, arguments: input }: Fields,
): HarnessEvent[] => {
  if (typeof server !== "string" || !server || typeof tool !== "string" || !tool) return []
  const toolName = mcpTool(server, tool)
  return [
    {
      type: "attention-resolved",
      ...base,
      requestId: callId(actor, toolName, callOf(input)),
      actor,
      toolName,
      loose: false,
      outcome: "settled",
    },
  ]
}

/** The plan a rollout line proposes, as `rolloutEvents` reads it. */
export const rolloutPlans = (line: string): readonly WrittenPlan[] =>
  rolloutEvents(line, { sessionId: "", instance: null }).flatMap((event) =>
    event.type === "plan-observed" ? [{ source: event.plan, at: event.startedAt }] : [],
  )

// A token count's usage and rate-limit windows.
const telemetry = (
  base: EventBase<"codex">,
  { info, rate_limits: limits }: Fields,
): HarnessEvent => {
  const usage = (info as { last_token_usage?: { total_tokens?: unknown } } | null)?.last_token_usage
  const occupied = number(usage?.total_tokens)
  const capacity = number((info as { model_context_window?: unknown } | null)?.model_context_window)
  const windows = (limits ?? {}) as {
    primary?: unknown
    secondary?: unknown
    limit_id?: unknown
    limit_name?: unknown
  }
  // Each snapshot is one limit's: the account's own (`codex`, or none named, as older ones),
  // or a model's, as `/status` names it, by its `limit_name`, else its id (rollouts of
  // 0.167.2 hold `premium` snapshots with no windows), which replaces that one's alone.
  const id = shortName(windows.limit_id, telemetryLimits.scope)
  const scope =
    id === undefined || id === "codex"
      ? undefined
      : (shortName(windows.limit_name, telemetryLimits.scope) ?? id)
  const known = [limit(windows.primary), limit(windows.secondary)]
    .filter((each): each is Limit => each !== undefined)
    .map((each) => (scope === undefined ? each : { ...each, scope }))
  return {
    type: "telemetry-observed",
    ...base,
    ...(occupied !== undefined && {
      context: {
        occupied: Math.max(0, Math.round(occupied)),
        capacity: capacity !== undefined && capacity >= 1 ? Math.round(capacity) : null,
      },
    }),
    ...(limits !== undefined &&
      limits !== null && {
        limits: known,
        limitsCover: scope === undefined ? ("account" as const) : { scope },
      }),
  }
}

// The kind a backlog event is kept by, one latest of each: a turn's model is a kind of its
// own, apart from the token counts, and so is the release's version; a model limit's
// snapshot is apart from the account's, as each replaces its own windows alone.
const backlogKind = (event: HarnessEvent): string =>
  event.type === "shell-started" || event.type === "shell-ended"
    ? `${event.type}:${event.id}`
    : event.type === "attention-resolved"
      ? `${event.type}:${event.requestId}`
      : event.type !== "telemetry-observed"
        ? event.type
        : event.model !== undefined || event.effort
          ? "model"
          : event.version !== undefined && event.context === undefined && event.limits === undefined
            ? "version"
            : typeof event.limitsCover === "object"
              ? `${event.type}:${event.limitsCover.scope}`
              : event.type

/**
 * Follows a bound session's rollout. Codex writes a turn's mode before the hook that
 * binds the session starts, so what the rollout already holds counts too: its latest
 * mode, as of now, and its latest plan and token count, as of when they were written;
 * then each record appended. A rollout rewritten, or another put in its place, is read
 * again: only what it records after the last record read before counts, as its own time
 * says, so an old record is never news and a new one is never lost.
 */
export const followRollout: NonNullable<Harness["watch"]> = async (run, signal, emit) => {
  // The latest of each kind the backlog held, until it has all been read.
  let backlog: Map<string, HarnessEvent> | undefined = new Map()
  // When the latest record read was written, and, once the file was rewritten, the time
  // a record of the rewritten file must be past to count.
  let latest = Number.NEGATIVE_INFINITY
  let after = Number.NEGATIVE_INFINITY
  // The shells of the backlog died with the process that ran them: only those started since
  // this follows count. The commands each exec_command call ran wait for their output.
  const began = Date.now()
  const commands: Commands = new Map()
  // Where the session writes it, which may not be where its hooks say.
  const path = await transcripts.locate(run.transcript, run.sessionId, null)
  return followLines(
    path ?? run.transcript,
    signal,
    (line) => {
      for (const event of rolloutEvents(line, run, commands)) {
        if (event.startedAt <= after) continue
        if (
          (event.type === "shell-started" || event.type === "shell-ended") &&
          event.startedAt < began
        )
          continue
        latest = Math.max(latest, event.startedAt)
        if (backlog) {
          const key = backlogKind(event)
          backlog.delete(key)
          backlog.set(key, event)
          // The runner can hold this many requests. Keep their separate settlements
          // without retaining every command ever completed in a long conversation.
          if (event.type === "attention-resolved") {
            const settled = [...backlog].filter(([, held]) => held.type === "attention-resolved")
            if (settled.length > agentLimits.requests) backlog.delete(settled[0]![0])
          }
        } else emit(event)
      }
    },
    {
      fromStart: true,
      onReset: () => {
        // Rewritten while its backlog was still being read: nothing was told yet.
        if (backlog) backlog = new Map()
        else after = latest
      },
      // Only once the file was there to read: one not written yet holds a backlog still.
      onIdle: (found) => {
        if (!backlog || !found) return
        // The mode holds until the next turn says otherwise, so it holds now, when the
        // binding that would otherwise predate it began; the rest keep their age.
        // Oldest first, as telemetry older than the last it took is turned away.
        const now = Date.now()
        const held = [...backlog.values()].map((event) =>
          event.type === "mode-observed"
            ? { ...event, startedAt: Math.max(event.startedAt, now) }
            : event,
        )
        for (const event of held.toSorted((a, b) => a.startedAt - b.startedAt)) emit(event)
        backlog = undefined
      },
    },
  )
}

/**
 * What one line of a subagent's own rollout says that no hook does: its turn aborted, as
 * Esc on its request does, firing neither `Interrupt` nor `SubagentStop` (probed
 * 2026-10-03, 0.159.3). Its turn over, it waits on the person no longer, though its
 * thread stays open, so it runs on; only an abort from `since` on, when its request was
 * asked, counts. An MCP tool call of its own completing settles its request too, as the
 * root's does in the root's rollout: one the person cancelled fires no hook, and its turn
 * runs on. That a subagent's item is filed in its own rollout is assumed, not probed: its
 * hooks name it by its own id, and the root's rollout holds its root's items alone.
 */
export const subagentEvents = (
  line: string,
  { sessionId, instance }: Pick<Run, "sessionId" | "instance">,
  actor: string,
  since: number,
): readonly HarnessEvent[] => {
  if (
    !line.includes('"turn_aborted"') &&
    !line.includes('"McpToolCall"') &&
    !line.includes('"CommandExecution"')
  )
    return []
  const { type, timestamp, payload } = parseFields(line) ?? {}
  if (type !== "event_msg" || typeof timestamp !== "string") return []
  const startedAt = Date.parse(timestamp)
  if (!Number.isFinite(startedAt) || startedAt < since) return []
  const { type: kind, item } = (payload ?? {}) as { type?: unknown; item?: unknown }
  if (kind === "turn_aborted")
    return [
      { type: "subagent-turn-aborted", agent: "codex", sessionId, instance, actor, startedAt },
    ]
  if (kind === "item_completed" && isFields(item) && item.type === "McpToolCall")
    return mcpSettled({ agent: "codex", sessionId, instance, startedAt }, actor, item)
  if (kind === "item_completed" && isFields(item) && item.type === "CommandExecution")
    return commandSettled({ agent: "codex", sessionId, instance, startedAt }, actor, item)
  return []
}

// How often a subagent's rollout is looked for until it is found.
const locateMs = 1000

/**
 * Follows a subagent's own rollout, which Codex files beside its root's under its own
 * id (its hooks name only the root's), for its turn aborting, or its MCP calls
 * completing, from `since` on. Looked for
 * until found, as Codex may write it after the hook that asks.
 */
export const followSubagent: NonNullable<Harness["watchActor"]> = async (
  run,
  actor,
  since,
  signal,
  emit,
) => {
  let path: string | undefined
  while (!signal.aborted) {
    // eslint-disable-next-line no-await-in-loop -- Each look follows the one before.
    path = await transcripts.locate(run.transcript, run.sessionId, actor)
    if (path) break
    // eslint-disable-next-line no-await-in-loop -- As above.
    await sleep(locateMs, undefined, { signal }).catch(() => {})
  }
  if (!path || signal.aborted) return
  await followLines(
    path,
    signal,
    (line) => {
      for (const event of subagentEvents(line, run, actor, since)) emit(event)
    },
    { fromStart: true },
  )
}
