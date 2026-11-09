import { presence, reportedOr, sessionName } from "@novadeck/harness-core/conversation"
import { fieldsOf, parseFields, type Fields } from "@novadeck/harness-core/fields"
import type { TranscriptDecoder, TranscriptEntry, UserEntry } from "@novadeck/harness-core/harness"
import { at, entry, noteEntry, textOf } from "@novadeck/harness-core/items"
import { outcome } from "@novadeck/harness-core/outcomes"
import { flavourOf } from "@novadeck/harness-core/paths"

import { callChange, launchedSubagent, stepOutcome } from "./outcomes.js"
import { describe } from "./tools.js"

// The person's words within the context Antigravity wraps a prompt in.
const request = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/

// How the plan review's Approve goes in, as a prompt (probed 2026-11-07, 1.5.2).
const planApproved = /^\[Approved\] \S+$/

// Each message a system step holds: its header (timestamp, sender, priority) and what it
// says, up to the next message or the block's end. A step may hold several, and several
// blocks.
const messages = /\[Message\] ([^\n]*?) content=([\s\S]*?)(?=\n\[Message\] |\n<\/SYSTEM_MESSAGE>)/g

// What Antigravity itself tells the root of a background subagent: that it went idle, with
// its last words, its report, where it said something; or that it failed, with the error.
// A subagent the root killed is told of by no message, and one left running when the root
// is interrupted reports with the root's next turn (probed 2026-11-09, 1.5.2,
// fixtures/subagent-transcript.probe.json and subagent-ends.probe.json).
const wentIdle =
  /^Subagent (\S+) has gone idle\.(?: This was the subagent's most recent response: ([\s\S]*))?$/
const failedLine =
  /^The subagent .* with id "([^"\n]+)" encountered an error and has either stopped or failed to start execution: /

type Ended = { readonly conversation: string; readonly text: string; readonly failed: boolean }

/** Each subagent a system step says went idle or failed, in its order. */
export const endedSubagents = (content: string): readonly Ended[] =>
  [...content.matchAll(messages)].flatMap(([, header, said]): Ended[] => {
    if (!/(?:^| )sender=system(?: |$)/.test(header!)) return []
    const idle = wentIdle.exec(said!)
    if (idle)
      return [{ conversation: idle[1]!, text: idle[2]?.trim() || "Went idle.", failed: false }]
    const error = failedLine.exec(said!)
    return error ? [{ conversation: error[1]!, text: said!.trim(), failed: true }] : []
  })

// The call that started each subagent, by its conversation: the launch's step comes before
// any word of its end in the file, which is read from its start. Conversation ids are
// unique, so every session's transcripts share it; the oldest go past a bound.
const launches = new Map<string, string>()
const launchesKept = 1000

const launched = (conversation: string, call: string): void => {
  launches.delete(conversation)
  launches.set(conversation, call)
  if (launches.size > launchesKept) launches.delete(launches.keys().next().value!)
}

/** Forgets every launch read: for tests, so none pairs through another's. */
export const forgetLaunches = (): void => launches.clear()

/** A subagent's end as a result of the call that started it; none for one not read. */
const endOf = (
  conversation: string,
  text: string,
  failed: boolean,
  time: number | null,
): TranscriptEntry[] => {
  const call = launches.get(conversation)
  return call
    ? [entry("tool", "tool-result", text, { at: time, call, outcome: outcome({ failed }) })]
    : []
}

/**
 * The subagents a manage_subagents call kills by their conversations, each as a failed
 * result of the call that started it: nothing else tells of their end. Its `kill_all` names
 * none, and a line names no session to tell this one's subagents by, so those run on.
 */
const killed = (name: unknown, args: unknown, time: number | null): TranscriptEntry[] => {
  const fields = fieldsOf(args)
  if (name !== "manage_subagents" || fields?.Action !== "kill") return []
  const ids = Array.isArray(fields.ConversationIds) ? fields.ConversationIds : []
  return ids.flatMap((id) => (typeof id === "string" ? endOf(id, "Killed.", true, time) : []))
}

const contentOf = (fields: Fields): string =>
  typeof fields.content === "string" ? fields.content : ""

// What a step says was typed into the box, unwrapped: a USER_EXPLICIT USER_INPUT step's
// text. Subagents' messages, hooks' continuations and notices are SYSTEM_MESSAGE steps.
const typed = (fields: Fields): string | undefined => {
  if (fields.source !== "USER_EXPLICIT" || fields.type !== "USER_INPUT") return undefined
  const content = contentOf(fields)
  return (request.exec(content)?.[1] ?? content).trim()
}

/**
 * The session's transcript in its own folder of the `brain` the reported path sits under,
 * where the reported one names another folder: Antigravity keeps each conversation's logs
 * under `brain/<session>`, whatever folder it runs in. One `stat`.
 */
const inOwnFolder = async (reported: string, sessionId: string): Promise<string | undefined> => {
  if (!sessionName.test(sessionId)) return undefined
  const rules = flavourOf(reported)
  for (let dir = rules.dirname(reported); rules.dirname(dir) !== dir; dir = rules.dirname(dir)) {
    const brain = rules.dirname(dir)
    if (rules.basename(brain) !== "brain") continue
    if (rules.basename(dir) === sessionId) return undefined
    const own = rules.join(brain, sessionId, rules.relative(dir, reported))
    // eslint-disable-next-line no-await-in-loop -- The nearest brain answers, and ends the loop.
    return (await presence(own)) === "present" ? own : undefined
  }
  return undefined
}

/**
 * Antigravity's transcript: a JSONL of the conversation's steps, which hooks name. The
 * person's input, the model's responses with their tool calls, and each call's result
 * as the next step, as many steps on as it came in its call's list, and a background
 * subagent's end, from the message its going idle or failing wakes the root with or the
 * call that kills it, as its launch's result; its reasoning and its other system steps stay
 * out. It names no subagents.
 */
export const transcripts: TranscriptDecoder = {
  locate: async (reported, sessionId, subagent) =>
    subagent === null
      ? reportedOr(reported, sessionId, () => inOwnFolder(reported, sessionId))
      : undefined,
  step: (line) => {
    const index = parseFields(line)?.step_index
    return typeof index === "number" ? index : undefined
  },
  items: (line) => {
    const fields = parseFields(line)
    if (!fields) return []
    const step = typeof fields.step_index === "number" ? fields.step_index : undefined
    const time = at(fields.created_at)
    const content = contentOf(fields)
    const text = typed(fields)
    if (text !== undefined) {
      if (planApproved.test(text)) return [noteEntry({ type: "plan-approved" }, time)]
      // A prompt says whether it goes in plan mode, by a <PLAN> in what wraps it; of any other
      // mode, as accept-edits, the record says nothing, so only leaving the plan shows.
      const mode = content.includes("<PLAN>") ? "plan" : "not-plan"
      return [
        noteEntry({ type: "mode", mode }, time),
        ...(text ? [entry("user", "text", text, { at: time })] : []),
      ]
    }
    if (fields.source === "SYSTEM" && fields.type === "CHECKPOINT")
      return [noteEntry({ type: "compaction" }, time, content)]
    if (fields.source === "SYSTEM" && fields.type === "SYSTEM_MESSAGE")
      return endedSubagents(content).flatMap((one) =>
        endOf(one.conversation, one.text, one.failed, time),
      )
    if (fields.source !== "MODEL") return []
    if (fields.type === "GENERIC") {
      const subagent = launchedSubagent(content)
      if (subagent !== undefined && step !== undefined) launched(subagent, `step:${step}`)
      return [
        entry("tool", "tool-result", content, {
          at: time,
          call: step === undefined ? undefined : `step:${step}`,
          outcome: stepOutcome(fields.status, fields.error, content),
        }),
      ]
    }
    if (fields.type !== "PLANNER_RESPONSE") return []
    const calls = (Array.isArray(fields.tool_calls) ? fields.tool_calls : []).flatMap(
      (call, index) => {
        const { name, args } = (call ?? {}) as { name?: unknown; args?: unknown }
        return [
          entry("assistant", "tool-call", textOf(args), {
            at: time,
            tool: name,
            call: step === undefined ? undefined : `step:${step + 1 + index}`,
            outcome: callChange(name, args),
            describe,
          }),
          ...killed(name, args, time),
        ]
      },
    )
    return [...(content ? [entry("assistant", "text", content, { at: time })] : []), ...calls]
  },
}

/**
 * What one transcript line records as typed into the box: the person's text (or a line
 * typed for them, as the doorbell's), its time and its step's index.
 */
export const typedEntry = (line: string): UserEntry | undefined => {
  const fields = parseFields(line)
  const text = fields && typed(fields)
  if (!fields || text === undefined) return undefined
  return {
    text,
    at: at(fields.created_at),
    id: typeof fields.step_index === "number" ? fields.step_index : null,
  }
}
