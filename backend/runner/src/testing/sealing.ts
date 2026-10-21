import { createTranscriptSealer, type TranscriptSealer } from "../terminals/sealing.js"

const key = new Uint8Array(32).fill(7)

// Opens what any `plainSealer` sealed; ready long before a test reads with it.
const reader = createTranscriptSealer(Promise.resolve(key))

/** A sealer with a fixed key, ready at once, so a test can open what was saved with `unsealed`. */
export const plainSealer = (): TranscriptSealer => createTranscriptSealer(Promise.resolve(key))

/** The text behind a value a `plainSealer` sealed for the terminal; null for none or any other value. */
export const unsealed = (value: string | null | undefined, terminalId: string): string | null =>
  value ? (reader.open(value, terminalId)?.text ?? null) : null

/** What a `plainSealer` seals `text` to for the terminal, saved at `at`. */
export const sealed = (text: string, terminalId: string, at = 5): string =>
  reader.seal(text, terminalId, at)!
