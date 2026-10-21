import { sealedPrefix, type TranscriptSealer } from "../terminals/sealing.js"

/**
 * A sealer that only marks a transcript as sealed, so a test can read what was saved:
 * it is ready at once, and its values are the text behind the prefix.
 */
export const plainSealer = (): TranscriptSealer => ({
  ready: Promise.resolve(true),
  seal: (text) => sealedPrefix + text,
  open: (value) => (value.startsWith(sealedPrefix) ? value.slice(sealedPrefix.length) : null),
})
