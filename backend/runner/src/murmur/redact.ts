// Murmur reads terminal text, and terminals show secrets: every string of a digest loses
// what looks like one (see @novadeck/secrets) before the text reaches the model.
import { redact, redactScreen } from "@novadeck/secrets"

import type { Input } from "./describer.js"

// A string that may be missing, redacted.
const one = (text: string | null): string | null => (text === null ? null : redact(text))

/** The input with every string run through `redact`. */
export const redactDigest = (digest: Input): Input => {
  if (digest.kind === "agent")
    return { ...digest, project: one(digest.project), summary: redact(digest.summary) }
  // Key blocks are masked whole, on the rows as they were drawn; then every row is seen on
  // its own, and, where it runs to the pane's edge, with the row that goes on from it.
  const screen = redactScreen(digest.screen, digest.continues ?? [])
  return {
    ...digest,
    project: one(digest.project),
    command: one(digest.command),
    screen,
  }
}
