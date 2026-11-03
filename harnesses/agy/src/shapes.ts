import { parseFields, type Fields } from "@novadeck/harness-core/fields"
import {
  classify,
  tagKeys,
  type Shape,
  type ShapeLists,
  type TranscriptStore,
} from "@novadeck/harness-core/shapes"

import { typedEntry } from "./transcripts.js"

/**
 * The shapes of Antigravity's transcript steps (see harness-core's shapes.ts), keyed as its
 * decoder tells them apart:
 * - `step:<source>/<type>`, a step by who wrote it and what it is;
 * - `media:<source>/<type>`, a step that carries images or other media besides its text;
 * - `tag:<name>`, the tag the person's input opens with (`<USER_REQUEST>`, which Antigravity
 *   wraps every prompt in), and the tag the words within it open with.
 */
export const lists: ShapeLists = {
  read: [
    "step:USER_EXPLICIT/USER_INPUT",
    "step:MODEL/PLANNER_RESPONSE",
    "step:MODEL/GENERIC",
    "tag:USER_REQUEST",
  ],
  skipped: [
    // Subagents' messages, hooks' continuations and notices, and injected messages.
    "step:SYSTEM/SYSTEM_MESSAGE",
    "step:SYSTEM_SDK/EPHEMERAL_MESSAGE",
    // An image a tool read, or the person gave, shows as the text beside it.
    "media:MODEL/GENERIC",
    "media:USER_EXPLICIT/USER_INPUT",
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
    ...(typed
      ? [...tagKeys(content), ...(typed.text === content.trim() ? [] : tagKeys(typed.text))]
      : []),
  ]
}

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
