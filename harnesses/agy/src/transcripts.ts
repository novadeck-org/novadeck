import { parseFields, type Fields } from "@novadeck/harness-core/fields"
import type { Harness, UserEntry } from "@novadeck/harness-core/harness"
import { at, entry, textOf } from "@novadeck/harness-core/items"

import { describe } from "./tools.js"

// The person's words within the context Antigravity wraps a prompt in.
const request = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/

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
 * Antigravity's transcript: a JSONL of the conversation's steps, which hooks name. The
 * person's input, the model's responses with their tool calls, and each call's result
 * as the next step, as many steps on as it came in its call's list; its reasoning and
 * its own system steps stay out. It names no subagents.
 */
export const transcripts: NonNullable<Harness["transcripts"]> = {
  locate: (root, _sessionId, subagent) => Promise.resolve(subagent === null ? root : undefined),
  items: (line) => {
    const fields = parseFields(line)
    if (!fields) return []
    const step = typeof fields.step_index === "number" ? fields.step_index : undefined
    const time = at(fields.created_at)
    const content = contentOf(fields)
    const text = typed(fields)
    if (text !== undefined) return text ? [entry("user", "text", text, { at: time })] : []
    if (fields.source !== "MODEL") return []
    if (fields.type === "GENERIC")
      return [
        entry("tool", "tool-result", content, {
          at: time,
          call: step === undefined ? undefined : `step:${step}`,
        }),
      ]
    if (fields.type !== "PLANNER_RESPONSE") return []
    const calls = (Array.isArray(fields.tool_calls) ? fields.tool_calls : []).map((call, index) => {
      const { name, args } = (call ?? {}) as { name?: unknown; args?: unknown }
      return entry("assistant", "tool-call", textOf(args), {
        at: time,
        tool: name,
        call: step === undefined ? undefined : `step:${step + 1 + index}`,
        describe,
      })
    })
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
