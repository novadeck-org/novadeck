import { parseFields, type Fields } from "@novadeck/harness-core/fields"
import {
  classify,
  tagKeys,
  type Shape,
  type ShapeLists,
  type TranscriptStore,
} from "@novadeck/harness-core/shapes"

import { holdsPaste, queuedPrompt, unwrapPasted } from "./transcripts.js"

/**
 * The shapes of Claude Code's transcript records (see harness-core's shapes.ts), keyed as
 * its decoder tells them apart:
 * - `record:<type>`, a record other than a message or an attachment;
 * - `meta:<type>`, a record Claude Code wrote for itself (`isMeta`), with the tag its text
 *   opens with (`meta:user/tag:system-reminder`) or its attachment's subtype, and
 *   `record:compact-summary`, its compaction's summary;
 * - `attachment:<type>`, an attachment by its subtype, a queued prompt also by who gave it
 *   and how (`attachment:queued_command/human/prompt`), and `record:queue-operation/<op>`;
 * - `block:<role>/<type>`, a block of a user's or assistant's message, plain text content
 *   counting as `text`;
 * - `tag:<name>`, the tag the person's text opens with, and `wrap:pasted_content`, a paste
 *   Claude Code wrapped further in (`wrap:pasted_content/raw`, one the decoder couldn't
 *   unwrap, is on no list).
 */
export const lists: ShapeLists = {
  read: [
    "block:user/text",
    "block:user/tool_result",
    "block:assistant/text",
    "block:assistant/tool_use",
    // The person's prompt that a running turn took in beside a tool's result (#482).
    "attachment:queued_command/human/prompt",
    "attachment:queued_command/human/none",
    // Shell mode (`!`): the command and what it printed.
    "tag:bash-input",
    "tag:bash-stdout",
    "tag:bash-stderr",
    // A slash command and what it printed.
    "tag:command-name",
    "tag:command-message",
    "tag:local-command-stdout",
    "tag:local-command-stderr",
    // A compaction's summary and the permission mode, notes between turns.
    "record:compact-summary",
    "record:permission-mode",
    // A paste Claude Code wrapped, which the decoder unwraps.
    "tag:pasted_content",
    "wrap:pasted_content",
  ],
  skipped: [
    // The model's reasoning stays out of the chat.
    "block:assistant/thinking",
    "block:assistant/redacted_thinking",
    // An image the person gave shows as its place in their words.
    "block:user/image",
    // A background task's notice, which Claude Code hands the model as the person's message,
    // and agents' messages Novadeck handed it as a prompt.
    "tag:task-notification",
    "tag:novadeck-messages",
    // Queued prompts that aren't the person's: a background task's notice, a peer's or a
    // coordinator's message, which Claude Code hands the turn the same way.
    "attachment:queued_command/task-notification/task-notification",
    "attachment:queued_command/none/task-notification",
    "attachment:queued_command/peer/prompt/meta",
    "attachment:queued_command/coordinator/none/meta",
    // What Claude Code writes for itself.
    "meta:user",
    "meta:user/tag:system-reminder",
    "meta:user/tag:local-command-caveat",
    "meta:assistant",
    "meta:system",
    // Records of its own state, which carry none of the conversation.
    "record:system",
    "record:summary",
    "record:custom-title",
    "record:ai-title",
    "record:agent-name",
    "record:tag",
    "record:mode",
    "record:last-prompt",
    "record:queue-operation/enqueue",
    "record:queue-operation/dequeue",
    "record:queue-operation/remove",
    "record:queue-operation/popAll",
    "record:file-history-snapshot",
    "record:file-history-delta",
    "record:pr-link",
    "record:frame-link",
    "record:session-owner",
    "record:cost-state",
    "record:tools-used",
    "record:atis-latch",
    "record:api-request",
    "record:api-request-blob",
    "record:api-request-shape",
    "record:artifact-autoreact-ledger",
    "record:artifact-comment-monitor",
    "record:continued-in",
    "record:worktree-state",
    "record:relocated",
    // Attachments of context, hooks and bookkeeping: none holds the person's words (a
    // prompt a turn took in is `queued_command`, read above). Seen in transcripts, or named
    // in the 2.1.316 binary as an attachment's type.
    "attachment:agent_listing_delta",
    "attachment:already_read_file",
    "attachment:async_hook_response",
    "attachment:auto_mode",
    "attachment:auto_mode_exit",
    "attachment:bash_output_audience_note",
    "attachment:batching_reminder_sent",
    "attachment:command_permissions",
    "attachment:compact_file_reference",
    "attachment:credential_org",
    "attachment:critical_system_reminder",
    "attachment:date",
    "attachment:deferred_tools_delta",
    "attachment:deferred_tools_record",
    "attachment:diagnostics",
    "attachment:directory",
    "attachment:dynamic_skill",
    "attachment:edited_text_file",
    "attachment:environment",
    "attachment:file",
    "attachment:hook_additional_context",
    "attachment:hook_blocking_error",
    "attachment:hook_cancelled",
    "attachment:hook_error_during_execution",
    "attachment:hook_non_blocking_error",
    "attachment:hook_permission_decision",
    "attachment:hook_stopped_continuation",
    "attachment:hook_success",
    "attachment:hook_system_message",
    "attachment:instructions",
    "attachment:invoked_skills",
    "attachment:max_turns_reached",
    "attachment:mcp_instructions_delta",
    "attachment:model",
    "attachment:nested_memory",
    "attachment:output_style",
    "attachment:plan_mode",
    "attachment:plan_mode_exit",
    "attachment:plan_mode_reentry",
    "attachment:prompt_snapshot",
    "attachment:read_truncation_notice",
    "attachment:remote_session_change",
    "attachment:session_context",
    "attachment:session_cron_carry",
    "attachment:silent_turn_reminder",
    "attachment:skill_listing",
    "attachment:structured_output",
    "attachment:task_reminder",
    "attachment:task_status",
    "attachment:teammate_mailbox",
    "attachment:thinking_drop",
    "attachment:todo_reminder",
    "attachment:total_tokens_reminder",
    "attachment:ultrathink_effort",
  ],
}

const verdicts = classify(lists)

// The keys of the person's text: the tag it opens with, and a paste wrapped further in. A
// paste is read only where the decoder unwraps it: one in a form it doesn't know (a new
// attribute, no line breaks) stays raw, and shows as a shape of its own.
const userText = (text: string): string[] => {
  const unwrapped = unwrapPasted(text)
  const tags = tagKeys(text)
  const opensWithPaste = tags.includes("tag:pasted_content")
  if (opensWithPaste && unwrapped === text) return ["wrap:pasted_content/raw"]
  return [...tags, ...(holdsPaste(text) && !opensWithPaste ? ["wrap:pasted_content"] : [])]
}

// The texts of a message's content: itself as a string, else its text blocks'.
const textsOf = (content: unknown): string[] =>
  typeof content === "string"
    ? [content]
    : (Array.isArray(content) ? content : []).flatMap((part) => {
        const { type, text } = (part ?? {}) as Fields
        return type === "text" && typeof text === "string" ? [text] : []
      })

// A queued prompt by who gave it and how (`queued_command/human/prompt`), and whether
// Claude Code wrote it for itself: only the person's own, as a prompt, is read, so a prompt
// of theirs that came another way, as #482's did, shows as a shape of its own.
const queuedKey = (attachment: Fields): string => {
  const origin = (attachment.origin ?? {}) as Fields
  const kind = typeof origin.kind === "string" ? origin.kind : "none"
  // No mode is read as a prompt, as the decoder reads it; a mode that is no string is not.
  const { commandMode } = attachment
  const mode =
    typeof commandMode === "string" ? commandMode : commandMode === undefined ? "none" : "untyped"
  return `attachment:queued_command/${kind}/${mode}${attachment.isMeta === true ? "/meta" : ""}`
}

const keysOf = (fields: Fields): string[] => {
  const type = typeof fields.type === "string" ? fields.type : "untyped"
  // What Claude Code wrote for itself, by the tags its text opens with: a prompt of the
  // person's it began writing so would show as a tag of its own.
  if (fields.isMeta === true && type === "attachment") {
    const attachment = (fields.attachment ?? {}) as Fields
    return [`meta:attachment/${typeof attachment.type === "string" ? attachment.type : "untyped"}`]
  }
  if (fields.isMeta === true) {
    const content = (fields.message as { content?: unknown } | undefined)?.content
    return [
      `meta:${type}`,
      ...textsOf(content).flatMap((text) => tagKeys(text).map((key) => `meta:${type}/${key}`)),
    ]
  }
  if (fields.isCompactSummary === true) return ["record:compact-summary"]
  if (type === "attachment") {
    const attachment = (fields.attachment ?? {}) as Fields
    const kind = typeof attachment.type === "string" ? attachment.type : "untyped"
    // Only a prompt the decoder reads as the person's has their text's shapes: a peer's or
    // a task's comes the same way, and stays out whole.
    const queued = queuedPrompt(fields)
    return [
      kind === "queued_command" ? queuedKey(attachment) : `attachment:${kind}`,
      ...(queued ? userText(queued.text) : []),
    ]
  }
  // A queue's operations by name: one that took a prompt in some new way shows as its own.
  if (type === "queue-operation")
    return [
      `record:queue-operation/${typeof fields.operation === "string" ? fields.operation : "untyped"}`,
    ]
  if (type !== "user" && type !== "assistant") return [`record:${type}`]
  const content = (fields.message as { content?: unknown } | undefined)?.content
  if (typeof content === "string")
    return [`block:${type}/text`, ...(type === "user" ? userText(content) : [])]
  return (Array.isArray(content) ? content : []).flatMap((part) => {
    const { type: block, text } = (part ?? {}) as Fields
    const kind = typeof block === "string" ? block : "untyped"
    return [
      `block:${type}/${kind}`,
      ...(type === "user" && kind === "text" && typeof text === "string" ? userText(text) : []),
    ]
  })
}

/**
 * Whether a shape is inside the conversation: a block of a user's or assistant's message, or
 * a prompt of the person's a running turn took in, whatever its mode (#482's was one), unless
 * marked meta, which the chat leaves out as Claude Code's own.
 */
export const conversational = (key: string): boolean =>
  key.startsWith("block:user/") ||
  key.startsWith("block:assistant/") ||
  (key.startsWith("attachment:queued_command/human/") && !key.endsWith("/meta"))

/** The shapes one line of a Claude Code transcript holds; none for a line that isn't JSON. */
export const shapes = (line: string): readonly Shape[] => {
  const fields = parseFields(line)
  return fields ? verdicts(keysOf(fields)) : []
}

/** Its sessions' and their subagents' JSONL, by project, under its home. */
export const store: TranscriptStore = { folder: "projects", file: /\.jsonl$/ }
