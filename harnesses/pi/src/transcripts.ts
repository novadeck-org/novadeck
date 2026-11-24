import { reportedOr } from "@novadeck/harness-core/conversation"
import { fieldsOf, parseFields, type Fields } from "@novadeck/harness-core/fields"
import type {
  ImageSource,
  TranscriptDecoder,
  TranscriptEntry,
} from "@novadeck/harness-core/harness"
import {
  at,
  entry,
  noteEntry,
  noticeEntries,
  textOf,
  withImages,
} from "@novadeck/harness-core/items"
import { exited, hunkChange, hunksOf, outcome } from "@novadeck/harness-core/outcomes"
import { flavourOf } from "@novadeck/harness-core/paths"
import type { TranscriptStore } from "@novadeck/harness-core/shapes"
import { shellCall } from "@novadeck/harness-core/tools"
import { isDelivery } from "@novadeck/protocol/harnesses"

import { describe } from "./tools.js"

/** Each session's transcript: `<time>_<id>.jsonl` under a folder per project. */
export const store: TranscriptStore = { folder: "sessions", file: /_[0-9A-Za-z._-]+\.jsonl$/ }

/** The customType of what Novadeck's extension puts into a session: deliveries and notices. */
export const ownType = "novadeck"

/**
 * One line of a pi session's file, parsed (docs/session-format.md, session version 3, 1.6.0):
 * every line is a record with a `type`, and the conversation's are `message` (a message of any
 * role), `custom_message` (an extension's message the model reads) and `compaction`.
 */
export const recordOf = (line: string): Fields | undefined => {
  const fields = parseFields(line)
  return typeof fields?.type === "string" ? fields : undefined
}

// When a message was made: its own time (milliseconds), else its record's.
const timeOf = (record: Fields, message?: Fields): number | null =>
  typeof message?.timestamp === "number" ? message.timestamp : at(record.timestamp)

// A content list's blocks, as fields.
const blocksOf = (content: unknown): readonly Fields[] =>
  typeof content === "string"
    ? [{ type: "text", text: content }]
    : (Array.isArray(content) ? content : []).flatMap((one): Fields[] => {
        const block = fieldsOf(one)
        return block ? [block] : []
      })

// The text blocks of a content list, together.
const wordsOf = (content: unknown): string =>
  blocksOf(content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")

// An image block's bytes, as pi keeps them inline.
const imageOf = (block: Fields): ImageSource | undefined =>
  block.type === "image" && typeof block.data === "string"
    ? { mime: typeof block.mimeType === "string" ? block.mimeType : null, base64: block.data }
    : undefined

/**
 * An image Novadeck gave pi: pi takes no image in its box, so the runner pastes the path of the
 * file it saved (`imagePaste`: `<data>/uploads/<uuid>/<name>`, a POSIX path with a backslash
 * before each special character, a Windows one in double quotes where it needs them), and the
 * model reads the file with its own tool. Only such a path counts, never one the person typed.
 * As the box reader marks it (box.ts).
 */
const uploaded =
  /"((?:[A-Za-z]:|\\\\)[^"]*[\\/]uploads[\\/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[\\/][^"\\/]+)"|((?:[A-Za-z]:)?(?:[\\/](?:\\.|[^\s\\/])+)*[\\/]uploads[\\/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[\\/](?:\\.|[^\s\\/])+)/g

// A file's image type, by its name, as the runner saves one.
const mimeOfName = (name: string): string | null => {
  const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase()
  return extension === "png"
    ? "image/png"
    : extension === "jpg" || extension === "jpeg"
      ? "image/jpeg"
      : extension === "gif"
        ? "image/gif"
        : extension === "webp"
          ? "image/webp"
          : null
}

/**
 * The person's words with each image path Novadeck pasted made `[Image #N]`, numbered after the
 * images the message holds inline, and the files those paths name, as the shell word was read.
 */
export const pastedImages = (
  words: string,
  before: number,
): { readonly text: string; readonly files: readonly ImageSource[] } => {
  const files: ImageSource[] = []
  const text = words.replace(
    uploaded,
    (_whole, quoted: string | undefined, bare: string | undefined) => {
      // A POSIX path's backslashes escape what follows; a Windows one's are its separators.
      const file = quoted ?? (bare?.startsWith("/") ? bare.replace(/\\(.)/g, "$1") : (bare ?? ""))
      files.push({ mime: mimeOfName(file), file })
      return `[Image #${before + files.length}]`
    },
  )
  return { text, files }
}

// How bash says it ended, at the end of its result: "Command exited with code N" (its tool's
// bash.ts, 1.6.0), where the command failed; a result without it ran to 0.
const exitLine = /\bCommand exited with code (\d+)\s*$/

/**
 * What came of a call, from its result: an error is a failure; a shell's exit code, which pi
 * writes at its result's end where it isn't 0; an edit's change, from the patch pi keeps beside it.
 */
const resultOutcome = (message: Fields, text: string) => {
  const tool = message.toolName
  if (tool === "bash" || tool === "powershell") {
    const code = exitLine.exec(text)?.[1]
    if (code !== undefined) return exited(Number(code))
    return message.isError === true ? outcome({ failed: true }) : exited(0)
  }
  if (message.isError === true) return outcome({ failed: true })
  const patch = fieldsOf(message.details)?.patch
  if (tool === "edit" && typeof patch === "string")
    return outcome({ failed: false, change: hunkChange(hunksOf(patch)) })
  return outcome({ failed: false })
}

// The items of an assistant's message: its words, its thinking, its tool calls.
const answerItems = (message: Fields, time: number | null): readonly TranscriptEntry[] => {
  const items = blocksOf(message.content).flatMap((block): TranscriptEntry[] => {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim())
      return [entry("assistant", "text", block.text, { at: time })]
    if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim())
      return [entry("assistant", "text", block.thinking, { at: time, thinking: true })]
    if (block.type === "toolCall")
      return [
        entry("assistant", "tool-call", textOf(block.arguments ?? {}), {
          at: time,
          tool: block.name,
          call: block.id,
          describe,
        }),
      ]
    return []
  })
  // Where the person stopped it: Escape aborts the answer, which pi records as `aborted`.
  return message.stopReason === "aborted"
    ? [...items, entry("user", "text", "Interrupted", { at: time, interrupted: true })]
    : items
}

// The items of a message of Novadeck's, its extension's: a delivery of agents' messages, which
// the chat reads apart, or Novadeck's standing notices.
const ownItems = (content: unknown, time: number | null): readonly TranscriptEntry[] => {
  const text = wordsOf(content)
  if (!text.trim()) return []
  return isDelivery(text) ? [entry("user", "text", text, { at: time })] : noticeEntries(text, time)
}

const messageItems = (record: Fields): readonly TranscriptEntry[] => {
  const message = fieldsOf(record.message)
  if (!message) return []
  const time = timeOf(record, message)
  switch (message.role) {
    case "user": {
      const inline = blocksOf(message.content).flatMap((block) => imageOf(block) ?? [])
      const { text, files } = pastedImages(wordsOf(message.content), inline.length)
      return withImages(
        text.trim() ? [entry("user", "text", text, { at: time })] : [],
        [...inline, ...files].map((image) => image.mime),
      )
    }
    case "assistant":
      return answerItems(message, time)
    case "toolResult": {
      const text = wordsOf(message.content)
      return [
        entry("tool", "tool-result", text, {
          at: time,
          call: message.toolCallId,
          outcome: resultOutcome(message, text),
        }),
      ]
    }
    // The person's own shell command (`!` or `!!`): the line they typed, the command, its output.
    case "bashExecution": {
      const command = typeof message.command === "string" ? message.command : ""
      const code = typeof message.exitCode === "number" ? message.exitCode : null
      const call = typeof record.id === "string" ? `shell-${record.id}` : undefined
      return [
        entry("user", "text", `!${command}`, { at: time }),
        entry("assistant", "tool-call", JSON.stringify({ command }), {
          at: time,
          tool: "bash",
          call,
          describe: shellCall,
        }),
        entry("tool", "tool-result", typeof message.output === "string" ? message.output : "", {
          at: time,
          call,
          outcome:
            code !== null
              ? exited(code)
              : outcome({ failed: message.cancelled === true ? true : null }),
        }),
      ]
    }
    case "custom":
      return message.customType === ownType ? ownItems(message.content, time) : []
    default:
      return []
  }
}

/**
 * The transcript pi writes for a session, read as it grows: the person's prompts and the images
 * they gave, the agent's words and thinking, each tool call and its result, the person's own
 * shell commands, what Novadeck delivered, and each compaction. pi keeps a session as a tree,
 * and `/tree` leaves a branch's records in the file as it moves on: they are read all the same.
 * Its system prompt, model and thinking-level changes, names, labels and extensions' state stay
 * out.
 */
export const transcripts: TranscriptDecoder = {
  // The session's file is the one pi reported; where it isn't there, pi's own store is looked
  // through for the session's id (a session resumed in another folder writes where it began).
  locate: (reported, sessionId) =>
    reportedOr(reported, sessionId, () => found(reported, sessionId)),
  images: (line) => {
    const record = recordOf(line)
    const message = record?.type === "message" ? fieldsOf(record.message) : undefined
    if (message?.role !== "user") return []
    const inline = blocksOf(message.content).flatMap((block) => imageOf(block) ?? [])
    return [...inline, ...pastedImages(wordsOf(message.content), inline.length).files]
  },
  items: (line) => {
    const record = recordOf(line)
    if (!record) return []
    switch (record.type) {
      case "message":
        return messageItems(record)
      // What an extension put into the session: Novadeck's own read as its deliveries.
      case "custom_message":
        return record.customType === ownType ? ownItems(record.content, at(record.timestamp)) : []
      case "compaction":
        return [
          noteEntry(
            { type: "compaction" },
            at(record.timestamp),
            typeof record.summary === "string" ? record.summary : "",
          ),
        ]
      default:
        return []
    }
  },
}

/**
 * A session's file by its id, in the store above the reported path's project folder:
 * `<sessions>/<project>/<time>_<id>.jsonl`.
 */
const found = async (reported: string, sessionId: string): Promise<string | undefined> => {
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(sessionId)) return undefined
  const rules = flavourOf(reported)
  const sessions = rules.dirname(rules.dirname(reported))
  const { readdir } = await import("node:fs/promises")
  for (const project of await readdir(sessions, { withFileTypes: true }).catch(() => [])) {
    if (!project.isDirectory()) continue
    const folder = rules.join(sessions, project.name)
    // eslint-disable-next-line no-await-in-loop -- Folders are read until one holds it.
    const names = await readdir(folder).catch(() => [] as string[])
    const name = names.find((each) => each.endsWith(`_${sessionId}.jsonl`))
    if (name !== undefined) return rules.join(folder, name)
  }
  return undefined
}
