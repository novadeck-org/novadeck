// Murmur reads terminal text, and terminals show secrets: every string of a digest loses
// what looks like one (see @novadeck/secrets) before the text reaches the model.
import { redact, redactScreen } from "@novadeck/secrets"

import type { Input } from "./describer.js"

// A string that may be missing, redacted.
const one = (text: string | null): string | null => (text === null ? null : redact(text))

/** The input with every string run through `redact`. */
export const redactDigest = (digest: Input): Input => {
  if (digest.kind === "question")
    return { ...digest, question: redact(digest.question), choices: digest.choices.map(redact) }
  if (digest.kind === "plan") return { ...digest, plan: redact(digest.plan) }
  if (digest.kind === "reply") return { ...digest, reply: redact(digest.reply) }
  const previous = digest.previous && { title: redact(digest.previous.title) }
  if (digest.kind === "shell") {
    // Key blocks are masked whole, on the rows as they were drawn; then every row is seen on
    // its own, and, where it runs to the pane's edge, with the row that goes on from it.
    const screen = redactScreen(digest.screen, digest.continues ?? [])
    return {
      ...digest,
      project: one(digest.project),
      folder: one(digest.folder),
      command: one(digest.command),
      screen,
      previous,
    }
  }
  return {
    ...digest,
    harness: redact(digest.harness),
    project: one(digest.project),
    folder: one(digest.folder),
    branch: one(digest.branch),
    plan: one(digest.plan),
    folders: digest.folders.map(redact),
    prompts: digest.prompts.map(redact),
    reply: one(digest.reply),
    summary: one(digest.summary),
    previous,
  }
}
