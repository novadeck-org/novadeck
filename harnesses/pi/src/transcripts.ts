import type { TranscriptDecoder } from "@novadeck/harness-core/harness"

/** pi's own session files, read directly. A skeleton: nothing is located or read yet. */
export const transcripts: TranscriptDecoder = {
  locate: () => Promise.resolve(undefined),
  items: () => [],
  images: () => [],
}
