import { readdir } from "node:fs/promises"
import { dirname, join } from "node:path"

import { reportedOr, rulesOf } from "@novadeck/harness-core/conversation"
import { parseFields, type Fields } from "@novadeck/harness-core/fields"
import type {
  ImageSource,
  TranscriptDecoder,
  TranscriptEntry,
} from "@novadeck/harness-core/harness"
import { at, entry, joined, noteEntry, textOf, withImages } from "@novadeck/harness-core/items"
import { exited } from "@novadeck/harness-core/outcomes"
import { fileList, shellCall } from "@novadeck/harness-core/tools"

import { asyncReplyText } from "./async-question.js"
import { rolloutAway } from "./conversation.js"
import { callChange, commandOutcome, fileChangeOutcome, outputOutcome } from "./outcomes.js"
import { describe, scriptOf } from "./tools.js"

// Context Codex writes into the conversation as the person's message; the note that tells
// the model a turn was interrupted, which 0.166.0 writes as the person's (0.165.0 and before
// as a developer's; the chat reads the interruption from the turn's abort event); and what a
// Stop hook gives back to go on with (`<hook_prompt>`, how Novadeck's hooks deliver agents'
// messages), which Claude Code keeps as an attachment of its own and the chat leaves out.
const context =
  /^\s*(<(environment_context|user_instructions|recommended_plugins|skill|subagent_notification|turn_aborted)[\s>]|<hook_prompt[\s>]|# AGENTS\.md instructions)/

/** The text of a message's parts, as the decoder reads it: without the tags around images. */
export const messageText = (content: unknown): string =>
  joined(withoutImageTags(content), ["input_text", "output_text"])

// A command the person ran in shell mode (`!`), with its exit code and output. A command
// that printed nothing leaves `Output:` and the closing tag on lines of their own.
const shell =
  /^\s*<user_shell_command>\n<command>\n([\s\S]*?)\n<\/command>\n<result>\nExit code: (-?\d+)\nDuration: [^\n]*\nOutput:\n([\s\S]*?)\n?<\/result>\n<\/user_shell_command>\s*$/

// The tags Codex writes around an image the person gave (0.163), naming its file: the
// prompt's own text holds the image's place (`[Image #1]`), so they stay out.
const imageTag = /^<image name=[^\n]*>$|^<\/image>$/

// A message's parts without the tags around its images.
const withoutImageTags = (content: unknown): unknown => {
  if (!Array.isArray(content)) return content
  const parts = content as ({ type?: unknown; text?: unknown } | null)[]
  const image = (index: number) => parts[index]?.type === "input_image"
  return parts.filter(
    (part, index) =>
      !(
        part?.type === "input_text" &&
        typeof part.text === "string" &&
        imageTag.test(part.text) &&
        (image(index - 1) || image(index + 1))
      ),
  )
}

// The images in a message's parts: the ones Codex holds inline, as a data URL of base64.
const dataImage = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=_-]+)$/
const imagesIn = (content: unknown): ImageSource[] =>
  (Array.isArray(content) ? content : []).flatMap((part): ImageSource[] => {
    const { type, image_url: url } = (part ?? {}) as { type?: unknown; image_url?: unknown }
    const found = type === "input_image" && typeof url === "string" ? dataImage.exec(url) : null
    return found ? [{ mime: found[1]!, base64: found[2]! }] : []
  })

// How many days after its parent's a subagent's rollout may start: Codex files each
// rollout under the day it starts, and a session can outlast midnight.
const days = 7

const dayFolder = (sessions: string, day: Date): string =>
  join(
    sessions,
    String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, "0"),
    String(day.getDate()).padStart(2, "0"),
  )

// The day folders from `folder` (sessions/YYYY/MM/DD) on, up to `days` of them, then
// today's and yesterday's, for a session resumed long after it began.
const dayFolders = (folder: string): string[] => {
  const match = /(\d{4})[/\\](\d{2})[/\\](\d{2})$/.exec(folder)
  if (!match) return [folder]
  const sessions = dirname(dirname(dirname(folder)))
  const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])]
  const later = Array.from({ length: days }, (_, offset) =>
    dayFolder(sessions, new Date(year, month, date + offset)),
  )
  const now = new Date()
  const recent = [0, 1].map((back) =>
    dayFolder(sessions, new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)),
  )
  return [...new Set([...later, ...recent])]
}

// A call's tool as `mcp__<server>__<tool>`, the way Codex names it elsewhere: its rollout
// records an MCP tool's server apart, as the call's `namespace` (`mcp__novadeck`).
const toolName = (payload: Fields): unknown =>
  typeof payload.namespace === "string" && typeof payload.name === "string"
    ? `${payload.namespace.replace(/_+$/, "")}__${payload.name}`
    : payload.name

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

// What a web search did, by its action as the 0.166.0 binary names it: a search's query (or
// queries), a page it opened, or a pattern it looked for in one; an action it doesn't name
// gives nothing.
const searchInput = (action: unknown): Fields => {
  const fields = (action ?? {}) as Fields
  const queries = Array.isArray(fields.queries)
    ? fields.queries.filter((each) => typeof each === "string").join(", ")
    : undefined
  const query = stringOf(fields.query) ?? queries
  const url = stringOf(fields.url)
  const pattern = stringOf(fields.pattern)
  return { ...(query && { query }), ...(url && { url }), ...(pattern && { pattern }) }
}

// A call of a tool the Responses API runs itself, with its status as its result.
const builtIn = (
  payload: Fields,
  tool: string,
  input: Fields,
  time: ReturnType<typeof at>,
): readonly TranscriptEntry[] => [
  entry("assistant", "tool-call", JSON.stringify(input), {
    at: time,
    tool,
    call: payload.id,
    describe,
  }),
  entry("tool", "tool-result", stringOf(payload.status) ?? "completed", {
    at: time,
    call: payload.id,
  }),
]

// The person's Esc, as Codex records it: the turn's abort, an event (the developer message
// it tells the model with stays out with the rest), read as the chat's note that they
// interrupted it (probed 2026-10, 0.162.1 and 0.165.0). Another reason, as a turn another
// replaced, is no interruption of theirs.
const interruption = (fields: Fields): readonly TranscriptEntry[] => {
  const payload = (fields.payload ?? {}) as Fields
  return payload.type === "turn_aborted" && payload.reason === "interrupted"
    ? [entry("user", "text", "Interrupted", { at: at(fields.timestamp), interrupted: true })]
    : []
}

// One file of a `FileChange` as a person reads a call: its path, then its diff or its text.
const changeText = ([path, change]: readonly [string, unknown]): string => {
  const { unified_diff: diff, content } = (change ?? {}) as Fields
  return [path, stringOf(diff) ?? stringOf(content) ?? ""].join("\n")
}

// A command or a patch a script of the agent's ran (`exec`, code mode, every model Codex lists
// since 0.16x), which Codex records as an event of its own, under an id of its own: no tool
// call, and nothing that names the script's. A call of the agent's own has its call's id on
// such an event, and a person's shell command another again; the call's item already tells
// those, so reading them too would show each twice. A patch that didn't apply leaves no event
// but the script's failure.
const scripted = (fields: Fields): readonly TranscriptEntry[] => {
  const payload = (fields.payload ?? {}) as Fields
  const item = (payload.item ?? {}) as Fields
  if (payload.type !== "item_completed" || !stringOf(item.id)?.startsWith("exec-")) return []
  const time = at(fields.timestamp)
  const row = { at: time, call: item.id, scripted: true }
  if (item.type === "CommandExecution") {
    return [
      entry("assistant", "tool-call", JSON.stringify({ cmd: scriptOf(item) }), {
        ...row,
        tool: "exec_command",
        describe,
      }),
      entry("tool", "tool-result", stringOf(item.aggregated_output) ?? "", {
        ...row,
        outcome: commandOutcome(item),
      }),
    ]
  }
  if (item.type === "FileChange") {
    const changes = Object.entries((item.changes ?? {}) as Fields)
    const files = changes.map(([path]) => path)
    return [
      entry("assistant", "tool-call", changes.map(changeText).join("\n"), {
        ...row,
        tool: "apply_patch",
        describe: () => ({ kind: "write", title: "Patched", detail: fileList(files) }),
      }),
      entry("tool", "tool-result", stringOf(item.stdout) || stringOf(item.stderr) || "", {
        ...row,
        outcome: fileChangeOutcome(item),
      }),
    ]
  }
  return []
}

/**
 * Codex's transcripts are its rollouts: the session's, and one per subagent, named for
 * its thread and kept under the day it started, its parent's or a later one. Each response
 * item holds the person's or the agent's text, another agent's message to it, a tool call
 * or its output; reasoning stays out, as do developer messages and the context Codex adds
 * as the person's. A command the person ran in shell mode is one user message, which reads
 * as the person's `!command` and a Bash run with its output, and its exit code when not
 * zero. The person's answer to an async question is a user message of Codex's own, which
 * reads as its history shows it: `Re: ` and the question, then the answer. A turn the person
 * interrupted reads as their interruption, where it ended. A command or a patch a script ran
 * reads as a call of its own, after the script's, marked `scripted`.
 */
// What a turn runs under, as its `turn_context` says: plan mode, else the approval policy, which
// is `on-request` as it starts. It says nothing of a plan's approval: the next turn's context
// just reads otherwise (probed 2026-11-07, 0.167.0).
const turnMode = (fields: Fields): readonly TranscriptEntry[] => {
  const payload = (fields.payload ?? {}) as Fields
  const { mode } = (payload.collaboration_mode ?? {}) as Fields
  const policy = payload.approval_policy
  const word = mode === "plan" ? "plan" : policy === "on-request" ? "default" : policy
  return typeof word === "string" && word
    ? [noteEntry({ type: "mode", mode: word }, at(fields.timestamp))]
    : []
}

export const transcripts: TranscriptDecoder = {
  images: (line) => {
    const fields = parseFields(line)
    const payload = (fields?.payload ?? {}) as Fields
    return fields?.type === "response_item" && payload.type === "message" && payload.role === "user"
      ? imagesIn(payload.content)
      : []
  },
  locate: async (reported, sessionId, subagent) => {
    const root = await reportedOr(reported, sessionId, () =>
      rolloutAway(reported, sessionId, rulesOf({ platform: process.platform })),
    )
    if (subagent === null) return root
    const suffix = `-${subagent}.jsonl`
    for (const folder of dayFolders(dirname(root))) {
      // eslint-disable-next-line no-await-in-loop -- The earliest day holding it wins.
      const names = await readdir(folder).catch(() => [])
      const name = names.find((each) => each.startsWith("rollout-") && each.endsWith(suffix))
      if (name) return join(folder, name)
    }
    return undefined
  },
  items: (line) => {
    const fields = parseFields(line)
    if (fields?.type === "event_msg") return [...interruption(fields), ...scripted(fields)]
    if (fields?.type === "turn_context") return turnMode(fields)
    if (fields?.type === "compacted") {
      const { message } = (fields.payload ?? {}) as Fields
      const text = typeof message === "string" ? message : ""
      return [noteEntry({ type: "compaction" }, at(fields.timestamp), text)]
    }
    if (fields?.type !== "response_item") return []
    const payload = (fields.payload ?? {}) as Fields
    const time = at(fields.timestamp)
    switch (payload.type) {
      case "message": {
        const { role } = payload
        if (role !== "user" && role !== "assistant") return []
        const text = messageText(payload.content)
        const reply = role === "user" ? asyncReplyText(text) : undefined
        if (reply !== undefined) return [entry("user", "text", reply, { at: time })]
        const ran = role === "user" ? shell.exec(text) : null
        if (ran) {
          const [, command = "", code = "", printed = ""] = ran
          const output = [printed.trimEnd(), code === "0" ? "" : `[exit code ${code}]`]
            .filter(Boolean)
            .join("\n")
          return [
            entry("user", "text", `!${command}`, { at: time }),
            entry("assistant", "tool-call", JSON.stringify({ command }), {
              at: time,
              tool: "Bash",
              call: payload.id,
              describe: shellCall,
            }),
            entry("tool", "tool-result", output || "(no output)", {
              at: time,
              call: payload.id,
              outcome: exited(Number(code)),
            }),
          ]
        }
        const said = text && !context.test(text) ? [entry(role, "text", text, { at: time })] : []
        return role === "user"
          ? withImages(
              said,
              imagesIn(payload.content).map(({ mime }) => mime),
            )
          : said
      }
      case "function_call":
      case "custom_tool_call": {
        const input = textOf(payload.type === "function_call" ? payload.arguments : payload.input)
        const tool = toolName(payload)
        return [
          entry("assistant", "tool-call", input, {
            at: time,
            tool,
            call: payload.call_id,
            outcome: callChange(tool, input),
            describe,
          }),
        ]
      }
      // A call of the Responses API's own tools, which Codex records as items of their own
      // (field names from the 0.166.0 binary). A shell call's output is a
      // `function_call_output` of its call, its command an argv. A search's results and an
      // image are the model's own, and Codex records each item once it is done, so its row's
      // result is its status: done, not running, and nothing lost.
      case "local_shell_call": {
        const { command } = (payload.action ?? {}) as Fields
        return [
          entry("assistant", "tool-call", JSON.stringify({ command }), {
            at: time,
            tool: "local_shell",
            call: payload.call_id ?? payload.id,
            describe,
          }),
        ]
      }
      case "web_search_call":
        return builtIn(payload, "web_search", searchInput(payload.action), time)
      case "image_generation_call":
        return builtIn(
          payload,
          "image_generation",
          typeof payload.revised_prompt === "string" ? { prompt: payload.revised_prompt } : {},
          time,
        )
      case "function_call_output":
      case "custom_tool_call_output": {
        const { output } = payload
        const text = Array.isArray(output) ? joined(output, ["input_text"]) : textOf(output)
        return [
          entry("tool", "tool-result", text, {
            at: time,
            call: payload.call_id,
            outcome: outputOutcome(text),
          }),
        ]
      }
      // Another agent's message to this one: a subagent's rollout holds its parent's, the
      // root's its subagents', each named by its path (`/root/<name>`).
      case "agent_message": {
        const text = joined(payload.content, ["input_text"])
        return text ? [entry("agent", "text", text, { at: time, author: payload.author })] : []
      }
      default:
        return []
    }
  },
}
