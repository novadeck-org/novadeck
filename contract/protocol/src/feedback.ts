import { z } from "zod"

import { agentName, id } from "./schemas.js"

// An agent's feedback draft for the people building Novadeck, written with its `feedback`
// tool: its kind and text, as the website takes a note (2,000 characters at most), and who
// wrote it. `asked` when the person asked that agent for it (`feedback.ask`) and the request
// reached it, not when the agent drafted it on its own. The runner holds drafts in memory
// only, one per terminal, until the app sends one or the person discards it
// (`feedback.settle`); it never sends one itself, and a restart forgets them.
export const feedbackKind = z.enum(["bug", "idea", "other"])
export const maxFeedbackText = 2000

export const feedbackDraft = z.strictObject({
  id,
  terminalId: id,
  projectId: id,
  workspaceSessionId: id,
  agent: agentName,
  handle: z.string(),
  at: z.number(),
  kind: feedbackKind,
  text: z.string().trim().min(1).max(maxFeedbackText),
  asked: z.boolean(),
})

export type FeedbackDraftEntry = z.infer<typeof feedbackDraft>
