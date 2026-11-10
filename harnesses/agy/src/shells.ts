import { errorText, shortName } from "@novadeck/harness-core/decode"
import type { ActivityEvent, EventBase } from "@novadeck/harness-core/events"
import { parseFields } from "@novadeck/harness-core/fields"
import { followLines } from "@novadeck/harness-core/follow"
import type { Harness, Run } from "@novadeck/harness-core/harness"
import { at } from "@novadeck/harness-core/items"
import { agentLimits } from "@novadeck/protocol"

import { transcripts } from "./transcripts.js"

/**
 * Antigravity's background shells, from its transcript alone (probed 2026-11-10, 1.5.3: its
 * hooks name no task, and a command's PostToolUse fires only when it ends, with no result).
 * A command that outlives its `WaitMsBeforeAsync` gets a `RUNNING` step the moment it goes
 * to the background:
 *
 *     Tool is running as a background task with task id: <conversation>/task-<step>
 *     Task Description: <the command>
 *     Task logs are available at: file:///…/task-<step>.log
 *
 * with the step's `created_at`. Its end is a system message to the agent, whether a turn
 * runs or not: `Task id "<id>" finished with result:` and `Command exited with code N.`, or
 * `Task id "<id>" was canceled with result:` for one the agent killed, which has no code
 * (the call's own step, `Task "<id>" cancelled.`, says the same).
 */
const running =
  /(?:^|\n)Tool is running as a background task with task id: (\S+)\nTask Description: ([\s\S]*?)\nTask logs are available at:/
const finished =
  /Task id "([^"\n]+)" (?:finished|was canceled) with result:\n(?:Command exited with code (-?\d{1,10})\.)?/g
const cancelled =
  /^(?:Created At: [^\n]*\n)?(?:Completed At: [^\n]*\n)?Task "([^"\n]+)" cancelled\.$/

// How many calls' tools are remembered, by their step, to tell a command from a timer.
const remembered = 64

/** The tool each call of a planner response will run, by the step its result takes. */
export type Calls = Map<number, string>

/**
 * What one line of an Antigravity transcript says of the root's background shells. `calls`
 * keeps the tool of each call made, by the step its result takes, so a background step of
 * another tool than a command (a timer) is no shell.
 */
export const shellEvents = (
  line: string,
  { sessionId, instance }: Pick<Run, "sessionId" | "instance">,
  calls: Calls = new Map(),
): readonly ActivityEvent[] => {
  if (
    !line.includes("background task") &&
    !line.includes("with result:") &&
    !line.includes("cancelled.") &&
    !line.includes('"PLANNER_RESPONSE"')
  )
    return []
  const fields = parseFields(line)
  if (!fields) return []
  const { step_index: step, source, type, content, status } = fields
  const startedAt = at(fields.created_at)
  if (typeof step !== "number" || startedAt === null) return []
  const base: EventBase<"agy"> = { agent: "agy", sessionId, instance, startedAt }
  const text = typeof content === "string" ? content : ""
  if (source === "MODEL" && type === "PLANNER_RESPONSE") {
    const list = Array.isArray(fields.tool_calls) ? fields.tool_calls : []
    list.forEach((call, index) => {
      const { name } = (call ?? {}) as { name?: unknown }
      if (typeof name === "string") calls.set(step + 1 + index, name)
    })
    while (calls.size > remembered) calls.delete(calls.keys().next().value!)
    return []
  }
  if (source === "MODEL" && type === "GENERIC") {
    if (status === "RUNNING") {
      const [, id, task] = running.exec(text) ?? []
      const name = calls.get(step)
      const command = errorText(task)
      const named = shortName(id, agentLimits.name)
      return named === undefined ||
        command === undefined ||
        (name !== undefined && name !== "run_command")
        ? []
        : [{ type: "shell-started", ...base, id: named, command }]
    }
    const killed = shortName(cancelled.exec(text)?.[1], agentLimits.name)
    return killed === undefined ? [] : [{ type: "shell-ended", ...base, id: killed, code: null }]
  }
  if (source !== "SYSTEM" || type !== "SYSTEM_MESSAGE") return []
  return [...text.matchAll(finished)].flatMap(([, id, code]): ActivityEvent[] => {
    const named = shortName(id, agentLimits.name)
    return named === undefined
      ? []
      : [
          {
            type: "shell-ended",
            ...base,
            id: named,
            code: code === undefined ? null : Number(code),
          },
        ]
  })
}

/**
 * Follows a bound session's transcript for its background shells, from where it is now: a
 * shell of an earlier run of a resumed conversation died with it. A transcript read again
 * (rewritten) tells no shell twice.
 */
export const followShells: NonNullable<Harness["watch"]> = async (run, signal, emit) => {
  const calls: Calls = new Map()
  const told = new Set<string>()
  const path = await transcripts.locate(run.transcript, run.sessionId, null)
  return followLines(path ?? run.transcript, signal, (line) => {
    for (const event of shellEvents(line, run, calls)) {
      if (event.type === "shell-started") {
        if (told.has(event.id)) continue
        told.add(event.id)
      }
      emit(event)
    }
  })
}
