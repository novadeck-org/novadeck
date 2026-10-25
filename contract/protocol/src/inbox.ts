import { z } from "zod"

import { agentName, id, murmurGist, turnError, turnFiles, turnReply } from "./schemas.js"
import { hiddenIn, maxCommandLines } from "./text.js"

const line = z
  .string()
  .trim()
  .min(1)
  .max(256)
  // eslint-disable-next-line no-control-regex -- Subjects cannot contain control characters.
  .refine((text) => !/[\r\n\x00-\x1f]/.test(text), "Use one line")
const markdown = z.string().max(16_384)

export const askOption = z.strictObject({
  label: line,
  summary: z.string().max(2048).nullable(),
  details: markdown.nullable(),
  code: z.strictObject({ path: line, text: markdown }).nullable(),
})

export const askShape = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text") }),
  z
    .strictObject({
      type: z.literal("options"),
      options: z.array(askOption).min(1).max(3),
      recommend: z.number().int().min(0).max(2).nullable(),
    })
    .refine(
      ({ options, recommend }) => recommend === null || recommend < options.length,
      "Recommend an offered option",
    ),
  z.strictObject({
    type: z.literal("action"),
    // Everything in sight: nothing that draws as nothing, and no more lines than a person
    // reads before running it (see `text.ts`).
    command: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine((text) => hiddenIn(text) === undefined, "Use only characters that show")
      .refine((text) => text.split("\n").length <= maxCommandLines, "Keep the command short"),
    directory: line.max(1024).nullable(),
    doneLabel: line,
  }),
])

export const agentAsk = z.strictObject({
  subject: line,
  body: markdown,
  details: markdown.nullable(),
  hardToUndo: z.string().max(2048).nullable(),
  shape: askShape,
})

export const askAnswer = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("reply"),
    option: z.number().int().min(0).max(2).nullable(),
    text: z.string().max(4096),
  }),
  z.strictObject({ type: z.literal("done") }),
])

export const inboxLetter = z.strictObject({
  id,
  terminalId: id,
  projectId: id,
  workspaceSessionId: id,
  agent: agentName,
  sessionId: z.string(),
  handle: z.string(),
  at: z.number(),
  content: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("ask"), ask: agentAsk }),
    z.strictObject({ kind: z.literal("tell"), subject: line, body: markdown }),
    // A finished turn of the agent: stored until the person reads it, which removes it.
    // `at` is the end's own `lastTurn.at`. `gist` is murmur's, filled in later.
    z.strictObject({
      kind: z.literal("turn"),
      outcome: z.enum(["completed", "failed"]),
      reply: turnReply.nullable(),
      gist: murmurGist.nullable(),
      error: turnError.nullable(),
      files: turnFiles,
    }),
  ]),
})

export type AgentAsk = z.infer<typeof agentAsk>
export type AskAnswer = z.infer<typeof askAnswer>
export type InboxLetter = z.infer<typeof inboxLetter>
