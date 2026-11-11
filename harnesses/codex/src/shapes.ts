import { parseFields, type Fields } from "@novadeck/harness-core/fields"
import {
  classify,
  tagKeys,
  type Shape,
  type ShapeLists,
  type TranscriptStore,
} from "@novadeck/harness-core/shapes"

import { messageText } from "./transcripts.js"

/**
 * The shapes of Codex's rollout records (see harness-core's shapes.ts), keyed as its decoder
 * tells them apart:
 * - `record:<type>`, a top-level record other than a response item or an event;
 * - `item:<type>`, a response item by its payload's type, a message also by its role
 *   (`item:message/user`);
 * - `event:<type>`, an event by its payload's type;
 * - `block:user/input_image`, an image in a user message;
 * - `tag:<name>`, the tag a user message's text opens with, and `tag:AGENTS.md`, the
 *   project's instructions Codex hands the model as one.
 */
export const lists: ShapeLists = {
  read: [
    "item:message/user",
    "item:message/assistant",
    "item:function_call",
    "item:function_call_output",
    "item:custom_tool_call",
    "item:custom_tool_call_output",
    // Calls of the Responses API's own tools: a shell command, a web search, an image.
    "item:local_shell_call",
    "item:web_search_call",
    "item:image_generation_call",
    // An image the person gave, held in its message as a data URL.
    "block:user/input_image",
    // Another agent's message to this one.
    "item:agent_message",
    // The person's Esc, which only an interrupted abort reads as.
    "event:turn_aborted",
    // What a script ran: its commands and patches, which only such items read as.
    "event:item_completed",
    // What a turn runs under, and a compaction: notes between turns.
    "record:turn_context",
    "record:compacted",
    // Shell mode (`!`), and the person's answer to an async question.
    "tag:user_shell_command",
    "tag:send_user_message_question_reply",
  ],
  skipped: [
    // The rollout's own bookkeeping.
    "record:session_meta",
    "record:world_state",
    "record:inter_agent_communication_metadata",
    "record:token_usage_record",
    // Copies Codex keeps for its own review and guardian work (0.166.0): the messages and
    // answers they hold are the conversation's response items, read above.
    "record:retained_context",
    "record:dynamic_tools_updated",
    "record:security_risk_score",
    // Reasoning, instructions for the model, and what compaction left.
    "item:reasoning",
    "item:message/developer",
    "item:message/system",
    "item:additional_tools",
    "item:compaction",
    // Compaction's own item by its older name, which 0.166.0 still reads (a serde alias).
    "item:compaction_summary",
    "item:compaction_trigger",
    "item:context_compaction",
    "item:configuration_update",
    // The model looking up which deferred tools to load, and what it found: the calls it
    // then makes are read above. Named in the 0.166.0 binary; no rollout here holds one yet.
    "item:tool_search_call",
    "item:tool_search_output",
    // The commit undo goes back to, named in the 0.166.0 binary as a response item; no
    // rollout here holds one yet.
    "item:ghost_snapshot",
    // Events mirror the response items, which the decoder reads instead.
    "event:agent_message",
    "event:agent_message_delta",
    "event:agent_reasoning",
    "event:agent_reasoning_delta",
    "event:agent_reasoning_raw_content",
    "event:agent_reasoning_section_break",
    "event:context_compacted",
    "event:entered_review_mode",
    "event:exec_command_begin",
    "event:exec_command_end",
    "event:exited_review_mode",
    "event:item_started",
    "event:mcp_tool_call_begin",
    "event:mcp_tool_call_end",
    "event:patch_apply_begin",
    "event:patch_apply_end",
    "event:task_complete",
    "event:task_started",
    "event:thread_rolled_back",
    "event:thread_settings_applied",
    "event:token_count",
    "event:turn_diff",
    "event:user_message",
    "event:view_image_tool_call",
    "event:web_search_begin",
    "event:web_search_end",
    // Context Codex writes as the person's message, and a Stop hook's continuation.
    "tag:environment_context",
    "tag:user_instructions",
    "tag:recommended_plugins",
    "tag:skill",
    "tag:subagent_notification",
    "tag:hook_prompt",
    // The note of an interrupted turn, which 0.166.0 writes as the person's; the turn's
    // abort event is what reads as the interruption.
    "tag:turn_aborted",
    "tag:AGENTS.md",
  ],
}

const verdicts = classify(lists)

const keysOf = (fields: Fields): string[] => {
  const type = typeof fields.type === "string" ? fields.type : "untyped"
  const payload = (fields.payload ?? {}) as Fields
  const kind = typeof payload.type === "string" ? payload.type : "untyped"
  if (type === "event_msg") return [`event:${kind}`]
  if (type !== "response_item") return [`record:${type}`]
  if (kind !== "message") return [`item:${kind}`]
  const role = typeof payload.role === "string" ? payload.role : "untyped"
  if (role !== "user") return [`item:message/${role}`]
  const text = messageText(payload.content)
  const parts: unknown[] = Array.isArray(payload.content) ? payload.content : []
  return [
    "item:message/user",
    ...(parts.some((part) => (part as Fields | null)?.type === "input_image")
      ? ["block:user/input_image"]
      : []),
    ...(/^\s*# AGENTS\.md instructions/.test(text) ? ["tag:AGENTS.md"] : tagKeys(text)),
  ]
}

/** Whether a shape is inside the conversation: a response item, a message by any role. */
export const conversational = (key: string): boolean => key.startsWith("item:")

/** The shapes one line of a Codex rollout holds; none for a line that isn't JSON. */
export const shapes = (line: string): readonly Shape[] => {
  const fields = parseFields(line)
  return fields ? verdicts(keysOf(fields)) : []
}

/** Its rollouts, the session's and its subagents', by day, under its home. */
export const store: TranscriptStore = {
  folder: "sessions",
  file: /(?:^|[\\/])rollout-[^\\/]*\.jsonl$/,
}
