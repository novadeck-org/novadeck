import { parseFields, type Fields } from "@novadeck/harness-core/fields"
import {
  classify,
  tagKeys,
  type Shape,
  type ShapeLists,
  type TranscriptStore,
} from "@novadeck/harness-core/shapes"

import { endedSubagents, typedEntry } from "./transcripts.js"

/**
 * The shapes of Antigravity's transcript steps (see harness-core's shapes.ts), keyed as its
 * decoder tells them apart:
 * - `step:<source>/<type>`, a step by who wrote it and what it is;
 * - `media:<source>/<type>`, a step that carries images or other media besides its text;
 * - `message:subagent-end`, a system message saying a background subagent went idle or failed;
 * - `tag:<name>`, the tag the person's input opens with (`<USER_REQUEST>`, which Antigravity
 *   wraps every prompt in), and the tag the words within it open with.
 */
export const lists: ShapeLists = {
  read: [
    "step:USER_EXPLICIT/USER_INPUT",
    "step:MODEL/PLANNER_RESPONSE",
    "step:MODEL/GENERIC",
    // A compaction, its summary its content (probed 2026-11-07, 1.5.2).
    "step:SYSTEM/CHECKPOINT",
    // A background subagent's going idle, its report, or its failing (probed 2026-11-09, 1.5.2).
    "message:subagent-end",
    "tag:USER_REQUEST",
    // An image the person gave, listed apart from the words and saved under the session
    // (probed 2026-10-31, 1.4.12).
    "media:USER_EXPLICIT/USER_INPUT",
  ],
  skipped: [
    // Subagents' messages, hooks' continuations and notices, and injected messages.
    "step:SYSTEM/SYSTEM_MESSAGE",
    "step:SYSTEM_SDK/EPHEMERAL_MESSAGE",
    // An image a tool read shows as the text beside it.
    "media:MODEL/GENERIC",
  ],
}

const verdicts = classify(lists)

const keysOf = (line: string, fields: Fields): string[] => {
  const source = typeof fields.source === "string" ? fields.source : "untyped"
  const type = typeof fields.type === "string" ? fields.type : "untyped"
  const media = Array.isArray(fields.media) && fields.media.length > 0
  const typed = typedEntry(line)
  const content = typeof fields.content === "string" ? fields.content : ""
  return [
    `step:${source}/${type}`,
    ...(media ? [`media:${source}/${type}`] : []),
    ...(source === "SYSTEM" && type === "SYSTEM_MESSAGE" && endedSubagents(content).length > 0
      ? ["message:subagent-end"]
      : []),
    ...(typed
      ? [...tagKeys(content), ...(typed.text === content.trim() ? [] : tagKeys(typed.text))]
      : []),
  ]
}

/** Whether a shape is inside the conversation: a step the model or the person wrote. */
export const conversational = (key: string): boolean =>
  key.startsWith("step:MODEL/") || key.startsWith("step:USER_EXPLICIT/")

/** The shapes one line of an Antigravity transcript holds; none for a line that isn't JSON. */
export const shapes = (line: string): readonly Shape[] => {
  const fields = parseFields(line)
  return fields ? verdicts(keysOf(line, fields)) : []
}

/** Each conversation's steps, untruncated, under its home. */
export const store: TranscriptStore = {
  folder: "brain",
  file: /^[^\\/]+[\\/]\.system_generated[\\/]logs[\\/]transcript_full\.jsonl$/,
}
