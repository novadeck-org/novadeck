import type { EventBase, HarnessEvent } from "./events.js"

/**
 * The prompts a session sees that aren't the person's own: Novadeck's doorbell line and
 * a hook's continuation; and the turn a root prompt starts, told apart by them.
 */

// The doorbell line's words, and a pattern of the whole line that captures its nonce.
const notice = "Novadeck: automatic notice, agent messages waiting"
const pattern = String.raw`\[${notice}, ([A-Za-z0-9]+)\]`

/** The line Novadeck's doorbell types, with its nonce (see docs/agent-messaging.md). */
export const doorbellLine = (nonce: string): string => `[${notice}, ${nonce}]`

/** Any doorbell line, wherever it is. */
export const doorbell = new RegExp(pattern, "g")

const doorbellOnly = new RegExp(`^${pattern}$`)

/** The nonce of a prompt that is exactly a doorbell line, as typed or started with; else undefined. */
export const doorbellNonce = (prompt: string): string | undefined =>
  doorbellOnly.exec(prompt.trim())?.[1]

/**
 * The person's prompt without any doorbell line left in it, as a line a failed ring left
 * in the box that they then submitted with their own text.
 */
export const withoutDoorbell = (prompt: string): string =>
  prompt
    .replace(doorbell, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()

/** Quotes a doorbell line for any shell Novadeck starts: it holds no character they expand. */
export const quotedLine = (line: string): string => `"${line}"`

/**
 * Whether a prompt is a delivery of agents' messages rather than the person's, in any
 * harness. A harness's own continuations it tells itself (see `promptStart`), and a doorbell
 * prompt is told apart by `doorbellNonce`.
 */
export const continuationPrompt = (prompt: string): boolean => prompt.includes("<novadeck-messages")

/**
 * The turn a root prompt starts, from its text: Novadeck's doorbell, a delivery (or
 * `harness` by the harness's own reckoning, as a Stop hook's reason it submits as a prompt),
 * or a prompt with the person's text, any doorbell line removed.
 */
export const promptStart = (
  base: EventBase & {
    /** The turn's id, where the harness names one. */
    readonly turn?: string
  },
  prompt: string,
  harness = false,
): HarnessEvent => {
  const nonce = doorbellNonce(prompt)
  if (nonce) return { type: "turn-started", ...base, cause: "doorbell", nonce }
  if (harness || continuationPrompt(prompt))
    return { type: "turn-started", ...base, cause: "harness" }
  const own = withoutDoorbell(prompt)
  return { type: "turn-started", ...base, cause: "prompt", ...(own && { prompt: own }) }
}
