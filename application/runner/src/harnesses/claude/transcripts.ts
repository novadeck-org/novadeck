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
 * tasks it hands the model as the person's message. A command the person runs in shell
 * mode (`!`) is two user records, the command and then its output, which read as the
 * person's `!command` and a Bash run (the output's record names the command's as its
 * parent, so they pair).
 */

// A background task's notice, in the person's place.
const notice = /^\s*<task-notification>/

// A shell-mode command, as `<bash-input>`; its output follows as stdout and stderr, which
// hold what the command printed, however it ended (a failed one's output is in stderr).
const shellInput = /^<bash-input>([\s\S]*)<\/bash-input>$/
const shellOutput = /^<bash-stdout>([\s\S]*)<\/bash-stdout><bash-stderr>([\s\S]*)<\/bash-stderr>$/

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
    if (typeof content === "string") {
      const command = role === "user" ? shellInput.exec(content)?.[1] : undefined
      if (command !== undefined)
        return [
          entry("user", "text", `!${command}`, { at: time }),
          entry("assistant", "tool-call", JSON.stringify({ command }), {
            at: time,
            tool: "Bash",
            call: fields.uuid,
          }),
        ]
      const output = role === "user" ? shellOutput.exec(content) : null
      if (output)
        return [
          entry(
            "tool",
            "tool-result",
            output
              .slice(1, 3)
              .map((each) => each!.trimEnd())
              .filter(Boolean)
              .join("\n"),
            { at: time, call: fields.parentUuid },
          ),
        ]
      return content && !notice.test(content) ? [entry(role, "text", content, { at: time })] : []
    }
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
