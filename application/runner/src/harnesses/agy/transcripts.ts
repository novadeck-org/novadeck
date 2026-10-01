import type { Harness, UserEntry } from "../harness.js"
import { at, entry, record, textOf } from "../items.js"

// The person's words within the context Antigravity wraps a prompt in.
const request = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/

/**
 * Antigravity's transcript: a JSONL of the conversation's steps, which hooks name. The
 * person's input, the model's responses with their tool calls, and each call's result
 * as the next step, as many steps on as it came in its call's list; its reasoning and
 * its own system steps stay out. It names no subagents.
 */
export const transcripts: NonNullable<Harness["transcripts"]> = {
  locate: (root, _sessionId, subagent) => Promise.resolve(subagent === null ? root : undefined),
  items: (line) => {
    const fields = record(line)
    if (!fields) return []
    const step = typeof fields.step_index === "number" ? fields.step_index : undefined
    const time = at(fields.created_at)
    const content = typeof fields.content === "string" ? fields.content : ""
    if (fields.source === "USER_EXPLICIT" && fields.type === "USER_INPUT") {
      const text = (request.exec(content)?.[1] ?? content).trim()
      return text ? [entry("user", "text", text, { at: time })] : []
    }
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
      })
    })
    return [...(content ? [entry("assistant", "text", content, { at: time })] : []), ...calls]
  },
}

/**
 * What one transcript line records as typed into the box: a USER_EXPLICIT USER_INPUT
 * step, the person's text (or a line typed for them, as the doorbell's) unwrapped, its
 * time and its step's index. Subagents' messages, hooks' continuations and notices are
 * SYSTEM_MESSAGE steps, never this.
 */
export const typedEntry = (line: string): UserEntry | undefined => {
  const fields = record(line)
  if (fields?.source !== "USER_EXPLICIT" || fields.type !== "USER_INPUT") return undefined
  const content = typeof fields.content === "string" ? fields.content : ""
  return {
    text: (request.exec(content)?.[1] ?? content).trim(),
    at: at(fields.created_at),
    id: typeof fields.step_index === "number" ? fields.step_index : null,
  }
}
