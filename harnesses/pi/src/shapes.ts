import {
  classify,
  type Shape,
  type ShapeLists,
  type TranscriptStore,
} from "@novadeck/harness-core/shapes"

/** The shapes of pi's session records the decoder reads, and those it skips knowingly. A skeleton. */
export const lists: ShapeLists = { read: [], skipped: [] }

const verdicts = classify(lists)

/** Whether a shape is inside the conversation. */
export const conversational = (_key: string): boolean => false

/** The shapes one line of the transcript holds. */
export const shapes = (_line: string): readonly Shape[] => verdicts([])

/** Each session's transcript: `<time>_<id>.jsonl` under a folder per project of its sessions folder. */
export const store: TranscriptStore = { folder: "sessions", file: /_[0-9A-Za-z._-]+\.jsonl$/ }
