import { z } from "zod"

import { agentName, turnError, turnFiles, turnReply } from "./agents.js"
import { id } from "./fields.js"
import { hiddenIn, maxCommandLines } from "./text.js"

// How long each text of an agent's ask, tell or done runs at most, in UTF-16 code units: a
// one-line subject or label (`line`), Markdown, an option's summary, why it is hard to undo,
// an action's command and its folder; and how many options an ask offers.
export const inboxTextLimits = {
  line: 256,
  markdown: 16_384,
  summary: 2048,
  hardToUndo: 2048,
  command: 4096,
  directory: 1024,
} as const
export const maxAskOptions = 3

const line = z
  .string()
  .trim()
  .min(1)
  .max(inboxTextLimits.line)
  // eslint-disable-next-line no-control-regex -- Subjects cannot contain control characters.
  .refine((text) => !/[\r\n\x00-\x1f]/.test(text), "Use one line")
const markdown = z.string().max(inboxTextLimits.markdown)

const askOption = z.strictObject({
  label: line,
  summary: z.string().max(inboxTextLimits.summary).nullable(),
  details: markdown.nullable(),
  code: z.strictObject({ path: line, text: markdown }).nullable(),
})

const askShape = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text") }),
  z
    .strictObject({
      type: z.literal("options"),
      options: z.array(askOption).min(1).max(maxAskOptions),
      recommend: z
        .number()
        .int()
        .min(0)
        .max(maxAskOptions - 1)
        .nullable(),
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
      .max(inboxTextLimits.command)
      .refine((text) => hiddenIn(text) === undefined, "Use only characters that show")
      .refine((text) => text.split("\n").length <= maxCommandLines, "Keep the command short"),
    directory: line.max(inboxTextLimits.directory).nullable(),
    doneLabel: line,
  }),
])

export const agentAsk = z.strictObject({
  subject: line,
  body: markdown,
  details: markdown.nullable(),
  hardToUndo: z.string().max(inboxTextLimits.hardToUndo).nullable(),
  shape: askShape,
})

export const askAnswer = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("reply"),
    option: z
      .number()
      .int()
      .min(0)
      .max(maxAskOptions - 1)
      .nullable(),
    text: z.string().max(4096),
  }),
  z.strictObject({ type: z.literal("done") }),
])

// How an ask ended without an answer from the Inbox, and when: the person dismissed it there,
// its agent withdrew it, or the person wrote to the agent in its terminal, which withdrew it.
// The runner keeps listing such an ask, settled, until the person clears it or it expires.
const askSettled = z.strictObject({
  how: z.enum(["dismissed", "withdrawn", "replied"]),
  at: z.number(),
})

export const inboxEntry = z.strictObject({
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
    // The agent's own report that the task it was given is finished.
    z.strictObject({ kind: z.literal("done"), subject: line, body: markdown }),
    // A finished turn of the agent: stored until the person reads it, which removes it.
    // `at` is the end's own `lastTurn.at`.
    z.strictObject({
      kind: z.literal("turn"),
      outcome: z.enum(["completed", "failed"]),
      reply: turnReply.nullable(),
      error: turnError.nullable(),
      files: turnFiles,
    }),
  ]),
  // Only on an ask that is no longer open (see `askSettled`).
  settled: askSettled.optional(),
})

export type AgentAsk = z.infer<typeof agentAsk>
export type AskAnswer = z.infer<typeof askAnswer>
export type InboxEntry = z.infer<typeof inboxEntry>
