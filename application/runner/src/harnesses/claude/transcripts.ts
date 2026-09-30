import { dirname, join } from "node:path"

import type { Harness } from "../harness.js"
import { at, entry, joined, record, textOf } from "../items.js"

// A subagent id Claude Code names its transcript by, as it writes them.
const safeId = /^[\w-]{1,128}$/

/**
 * Claude Code's transcripts: the session's JSONL, and beside it a folder named for the
 * session with a JSONL per subagent. Each user or assistant record holds its message's
 * text, tool calls and tool results; thinking stays out, as do the records Claude Code
 * writes for itself (`isMeta`), its compaction summaries, and the notices of background
 * tasks it hands the model as the person's message.
 */

// A background task's notice, in the person's place.
const notice = /^\s*<task-notification>/
export const transcripts: NonNullable<Harness["transcripts"]> = {
  locate: (root, sessionId, subagent) => {
    if (subagent === null) return Promise.resolve(root)
    if (!safeId.test(subagent) || !safeId.test(sessionId)) return Promise.resolve(undefined)
    return Promise.resolve(join(dirname(root), sessionId, "subagents", `agent-${subagent}.jsonl`))
  },
  items: (line) => {
    const fields = record(line)
    const role = fields?.type
    if (
      !fields ||
      (role !== "user" && role !== "assistant") ||
      fields.isMeta === true ||
      fields.isCompactSummary === true
    )
      return []
    const time = at(fields.timestamp)
    const content = (fields.message as { content?: unknown } | undefined)?.content
    if (typeof content === "string")
      return content && !notice.test(content) ? [entry(role, "text", content, { at: time })] : []
    return (Array.isArray(content) ? content : []).flatMap((part) => {
      const {
        type,
        text,
        name,
        input,
        id,
        content: result,
        tool_use_id: call,
      } = (part ?? {}) as Record<string, unknown>
      if (type === "text" && typeof text === "string" && text)
        return [entry(role, "text", text, { at: time })]
      if (type === "tool_use")
        return [entry("assistant", "tool-call", textOf(input), { at: time, tool: name, call: id })]
      if (type === "tool_result")
        return [
          entry(
            "tool",
            "tool-result",
            typeof result === "string" ? result : joined(result, ["text"]),
            { at: time, call },
          ),
        ]
      return []
    })
  },
}
