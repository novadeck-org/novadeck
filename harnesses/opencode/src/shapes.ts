import {
  classify,
  tagKeys,
  type Shape,
  type ShapeLists,
  type TranscriptStore,
} from "@novadeck/harness-core/shapes"

import { lineOf } from "./transcripts.js"

/**
 * The shapes of the transcript Novadeck's plugin writes for opencode (see harness-core's
 * shapes.ts), keyed as its decoder tells them apart:
 * - `line:<type>`, a line's own kind, as the plugin writes it (`prompt`, `message`, `part`);
 * - `part:<role>/<type>`, a part of an answer, or of a subagent's prompt, by its author and
 *   opencode's part type;
 * - `prompt:<type>`, a part of the person's prompt;
 * - `tag:<name>`, the tag a prompt's words open with;
 * - `message:aborted`, an answer the person interrupted, its info's `MessageAbortedError`.
 */
export const lists: ShapeLists = {
  read: [
    "line:prompt",
    "line:part",
    "prompt:text",
    // An image the person attached (opencode 1.19.6 makes a `file` part of it).
    "prompt:file",
    "part:assistant/text",
    "part:assistant/tool",
    // A compaction's marker (session/compaction.ts).
    "part:assistant/compaction",
    "part:user/text",
    "part:user/compaction",
    // The Inbox reply tag, typed by the doorbell as the person's own prompt.
    "tag:novadeck-reply",
    "tag:novadeck-messages",
    // Where the person interrupted an answer (Escape twice).
    "message:aborted",
  ],
  skipped: [
    // An answer's info once it is done: its model, tokens and cost, which hooks tell.
    "line:message",
    // The model's reasoning, which its TUI shows folded, never words to the person.
    "part:assistant/reasoning",
    // A model call's start and end, with its tokens.
    "part:assistant/step-start",
    "part:assistant/step-finish",
    // The files a step changed, as opencode's undo keeps them.
    "part:assistant/snapshot",
    "part:assistant/patch",
    // A retry of a failed model call.
    "part:assistant/retry",
    // The file an `@` mention named, which opencode adds to the prompt as a synthetic part.
    "tag:path",
    // A subagent's prompt as its parent's task call gave it; the call shows it.
    "part:user/subtask",
    "part:user/agent",
    "prompt:agent",
    "prompt:subtask",
  ],
}

const verdicts = classify(lists)

const keysOf = (line: string): string[] => {
  const read = lineOf(line)
  if (!read) return []
  if (read.type === "message")
    return [
      "line:message",
      ...(read.info.role === "assistant" &&
      (read.info.error as { name?: unknown } | undefined)?.name === "MessageAbortedError"
        ? ["message:aborted"]
        : []),
    ]
  if (read.type === "part")
    return ["line:part", `part:${read.role ?? "unknown"}/${String(read.part.type ?? "untyped")}`]
  return [
    "line:prompt",
    ...read.parts.flatMap((part) => [
      `prompt:${String(part.type ?? "untyped")}`,
      ...(part.type === "text" && typeof part.text === "string" ? tagKeys(part.text) : []),
    ]),
  ]
}

/** Whether a shape is inside the conversation: a part of the person's or the agent's message. */
export const conversational = (key: string): boolean =>
  key.startsWith("part:") || key.startsWith("prompt:") || key === "message:aborted"

/** The shapes one line of the transcript holds; none for a line of anything else. */
export const shapes = (line: string): readonly Shape[] => verdicts(keysOf(line))

/** Each session's transcript, in the plugin's folder. */
export const store: TranscriptStore = {
  folder: "sessions",
  file: /^ses_[0-9A-Za-z]+\.jsonl$/,
}
