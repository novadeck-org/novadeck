import { fieldsOf } from "@novadeck/harness-core/fields"
import {
  classify,
  tagKeys,
  type Shape,
  type ShapeLists,
  type TranscriptStore,
} from "@novadeck/harness-core/shapes"

import { ownType, recordOf } from "./transcripts.js"

/** Each session's transcript: `<time>_<id>.jsonl` under a folder per project of its sessions folder. */
export const store: TranscriptStore = { folder: "sessions", file: /_[0-9A-Za-z._-]+\.jsonl$/ }

/**
 * The shapes of a pi session's records (see harness-core's shapes.ts, and pi's
 * docs/session-format.md, version 3, 1.6.0), keyed as its decoder tells them apart:
 * - `record:<type>`, a line's own kind;
 * - `message:<role>`, a message's role;
 * - `block:<role>/<type>`, a block of a message's content;
 * - `custom:<customType>`, an extension's message, Novadeck's (`novadeck`) or another's;
 * - `tag:<name>`, the tag the person's words open with;
 * - `message:aborted`, an answer the person interrupted.
 */
export const lists: ShapeLists = {
  read: [
    "record:message",
    "record:custom_message",
    "record:compaction",
    "message:user",
    "message:assistant",
    "message:toolResult",
    "message:bashExecution",
    "message:custom",
    "message:aborted",
    "block:user/text",
    "block:user/image",
    "block:assistant/text",
    "block:assistant/thinking",
    "block:assistant/toolCall",
    "block:toolResult/text",
    "block:toolResult/image",
    "block:custom/text",
    `custom:${ownType}`,
    // The Inbox reply tag, typed by the doorbell as the person's own prompt.
    "tag:novadeck-reply",
    "tag:novadeck-messages",
  ],
  skipped: [
    // The file's header: its id, version and folder.
    "record:session",
    // The model and thinking level chosen, which the hooks tell.
    "record:model_change",
    "record:thinking_level_change",
    // A session's name, an entry's label, and usage outside an answer (cache warming).
    "record:session_info",
    "record:label",
    "record:usage",
    // An extension's own state, never in the model's context.
    "record:custom",
    // An edit of what the model reads of an earlier record, which keeps the record itself.
    "record:context_edit",
    // A summary of a branch the person left with /tree.
    "record:branch_summary",
    // The system prompt and its patches, as pi keeps them in the session.
    "message:system",
    "block:system/text",
    // pi's own context messages of a branch's and a compaction's summary (the record is read).
    "message:branchSummary",
    "message:compactionSummary",
  ],
}

const verdicts = classify(lists)

const keysOf = (line: string): string[] => {
  const record = recordOf(line)
  if (!record) return []
  const kind = `record:${String(record.type)}`
  if (record.type === "custom_message")
    return [kind, `custom:${String(record.customType ?? "untyped")}`]
  if (record.type !== "message") return [kind]
  const message = fieldsOf(record.message)
  if (!message) return [kind]
  const role = String(message.role ?? "unknown")
  const content = Array.isArray(message.content)
    ? message.content
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : []
  return [
    kind,
    `message:${role}`,
    ...(role === "assistant" && message.stopReason === "aborted" ? ["message:aborted"] : []),
    ...(role === "custom" ? [`custom:${String(message.customType ?? "untyped")}`] : []),
    ...content.flatMap((one) => {
      const block = fieldsOf(one)
      if (!block) return []
      return [
        `block:${role}/${String(block.type ?? "untyped")}`,
        ...(role === "user" && block.type === "text" && typeof block.text === "string"
          ? tagKeys(block.text)
          : []),
      ]
    }),
  ]
}

/** Whether a shape is inside the conversation: a message's role, or a block of one. */
export const conversational = (key: string): boolean =>
  key.startsWith("message:") || key.startsWith("block:") || key.startsWith("custom:")

/** The shapes one line of the transcript holds; none for a line of anything else. */
export const shapes = (line: string): readonly Shape[] => verdicts(keysOf(line))
