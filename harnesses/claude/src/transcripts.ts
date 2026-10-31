import { dirname, join } from "node:path"

import { parseFields } from "@novadeck/harness-core/fields"
import type { Harness, TranscriptEntry } from "@novadeck/harness-core/harness"
import { at, entry, joined, textOf } from "@novadeck/harness-core/items"
import { shellCall } from "@novadeck/harness-core/tools"

import { taskNotification } from "./decode.js"
import { interruption } from "./interruption.js"
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
 * parent, so they pair). A prompt the person gives while a turn runs, which Claude Code
 * takes into that turn beside a tool's result, is no user record but an attachment of the
 * turn (see `queuedPrompt`); it reads as the person's prompt all the same.
 */

// A shell-mode command, as `<bash-input>`; its output follows as stdout and stderr, which
// hold what the command printed, however it ended (a failed one's output is in stderr).
const shellInput = /^<bash-input>([\s\S]*)<\/bash-input>$/
const shellOutput = /^<bash-stdout>([\s\S]*)<\/bash-stdout><bash-stderr>([\s\S]*)<\/bash-stderr>$/

/**
 * The person's prompt that a `queued_command` attachment carries, and when they gave it:
 * Claude Code writes one for a prompt it takes into the running turn, as a tool's result
 * comes, rather than as a turn of its own (since at least 2.1.289; its queue logs `absorbed_mid_turn`).
 * Only a human origin is the person's: a background task's notice, a peer's or a
 * coordinator's message comes the same way, as do Claude Code's own (`isMeta`), and an
 * attachment that names no origin is left out with them. A prompt with an image is a list
 * of blocks, whose text reads as the prompt.
 */
const queuedPrompt = (
  fields: Record<string, unknown>,
): { readonly text: string; readonly at: unknown } | undefined => {
  const queued = (fields.attachment ?? {}) as Record<string, unknown>
  const { origin, commandMode: mode, prompt } = queued
  if (
    queued.type !== "queued_command" ||
    queued.isMeta === true ||
    (origin as { kind?: unknown } | undefined)?.kind !== "human" ||
    (mode !== undefined && mode !== "prompt")
  )
    return undefined
  const text = typeof prompt === "string" ? prompt : joined(prompt, ["text"])
  return { text, at: queued.timestamp ?? fields.timestamp }
}

// The items of a record's text content: the person's shell-mode command or its output, or
// the text itself unless it is a background task's notice.
const textItems = (
  role: "user" | "assistant",
  content: string,
  time: number | null,
  fields: Record<string, unknown>,
): TranscriptEntry[] => {
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
  return content && !taskNotification.test(content)
    ? [entry(role, "text", content, { at: time, interrupted: interruption(content) })]
    : []
}

export const transcripts: NonNullable<Harness["transcripts"]> = {
  locate: (root, sessionId, subagent) => {
    if (subagent === null) return Promise.resolve(root)
    if (!safeId.test(subagent) || !safeId.test(sessionId)) return Promise.resolve(undefined)
    return Promise.resolve(join(dirname(root), sessionId, "subagents", `agent-${subagent}.jsonl`))
  },
  items: (line) => {
    const fields = parseFields(line)
    if (!fields || fields.isMeta === true || fields.isCompactSummary === true) return []
    if (fields.type === "attachment") {
      const queued = queuedPrompt(fields)
      return queued ? textItems("user", queued.text, at(queued.at), fields) : []
    }
    const role = fields.type
    if (role !== "user" && role !== "assistant") return []
    const time = at(fields.timestamp)
    const content = (fields.message as { content?: unknown } | undefined)?.content
    if (typeof content === "string") return textItems(role, content, time, fields)
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
        return [entry(role, "text", text, { at: time, interrupted: interruption(text) })]
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
