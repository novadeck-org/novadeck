import { dirname, join } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"
import { at, entry, joined, record, textOf } from "@novadeck/harness-core/items"
import { shellCall } from "@novadeck/harness-core/tools"

import { describe } from "./tools.js"

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

// What Claude Code appends as the assistant's answer to a resumed conversation that ends
// on a message nothing answered; other synthetic answers (a usage limit, an expired login)
// say an error ended the turn.
const unanswered = "No response requested."

// Records Claude Code writes as the person's, which no turn answers: a command's output.
const commandRecord = /^\s*<(?:command-name|command-message|local-command-|bash-)/

/**
 * Whether the last turn of a session was cut short, from its tail (see
 * `Harness["transcripts"].cutShort`): its last message is the person's prompt, a task
 * notice or a tool's result that nothing answered, and no error ended it. Claude Code
 * answers such a conversation on resume with a synthetic "No response requested." and
 * waits at its prompt, so a turn the stop cut stays cut until someone says to go on. An
 * assistant message last, even a tool call, may be a question waiting on the person.
 */
export const cutShort = (lines: readonly string[]): boolean => {
  let cut = false
  for (const line of lines) {
    if (!line.includes('"user"') && !line.includes('"assistant"')) continue
    const fields = record(line)
    const role = fields?.type
    if (
      !fields ||
      (role !== "user" && role !== "assistant") ||
      fields.isSidechain === true ||
      fields.isMeta === true ||
      fields.isCompactSummary === true
    )
      continue
    const message = fields.message as { content?: unknown; model?: unknown } | undefined
    const content = message?.content
    if (role === "assistant") {
      const synthetic = message?.model === "<synthetic>"
      // The resume's own answer leaves the cut as it was; any other ends the turn.
      if (synthetic && joined(content, ["text"]).trim() === unanswered) continue
      cut = false
      continue
    }
    if (
      Array.isArray(content) &&
      content.some((part) => (part as { type?: unknown })?.type === "tool_result")
    ) {
      cut = true
      continue
    }
    const text = typeof content === "string" ? content : joined(content, ["text"])
    if (!text.trim() || commandRecord.test(text)) continue
    cut = !text.trimStart().startsWith("[Request interrupted by user")
  }
  return cut
}

export const transcripts: NonNullable<Harness["transcripts"]> = {
  cutShort,
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
            describe: shellCall,
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
        return [
          entry("assistant", "tool-call", textOf(input), {
            at: time,
            tool: name,
            call: id,
            describe,
          }),
        ]
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
