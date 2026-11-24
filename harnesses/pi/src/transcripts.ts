import type { TranscriptDecoder } from "@novadeck/harness-core/harness"
import type { TranscriptStore } from "@novadeck/harness-core/shapes"

/** pi's own session files, read directly. A skeleton: nothing is located or read yet. */
export const transcripts: TranscriptDecoder = {
  locate: () => Promise.resolve(undefined),
  items: () => [],
  images: () => [],
}

/** Each session's transcript: `<time>_<id>.jsonl` under a folder per project. */
export const store: TranscriptStore = { folder: "sessions", file: /_[0-9A-Za-z._-]+\.jsonl$/ }
