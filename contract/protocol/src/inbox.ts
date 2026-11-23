import { z } from "zod"

import { agentNameRead, turnError, turnFiles, turnReply } from "./agents.js"
import { id } from "./fields.js"
import { openUnion } from "./open.js"
import { hiddenIn, maxCommandLines, unsafeInLine } from "./text.js"

// How long each text of an agent's ask, tell or done runs at most, in UTF-16 code units: a
// one-line subject or label (`line`), Markdown, an option's summary, why it is hard to undo,
// an action's command and its folder, a question and its short header; how many options an
// ask offers; and how many questions one asks at once, each with how many options.
export const inboxTextLimits = {
  line: 256,
  markdown: 16_384,
  summary: 2048,
  hardToUndo: 2048,
  command: 4096,
  directory: 1024,
  question: 2048,
  header: 64,
} as const
export const maxAskOptions = 3
export const maxAskQuestions = 4
export const maxQuestionOptions = 4

// One line of at most `max` characters, without what one line may not hold (`unsafeInLine`);
// the runner strips all of that but line breaks and tabs from an agent's text first. A longer
// one is its own schema: a second `max` on a string keeps the first.
const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !unsafeInLine.test(text), "Use one line")
const line = oneLine(inboxTextLimits.line)
const markdown = z.string().max(inboxTextLimits.markdown)

const askOption = z.strictObject({
  label: line,
  summary: z.string().max(inboxTextLimits.summary).nullable(),
  details: markdown.nullable(),
  code: z.strictObject({ path: line, text: markdown }).nullable(),
})

// One of several questions an ask puts at once: its short header (the tab it is on), the question,
// its options, whether several of them may be picked, and the one the agent would pick, by
// index. The person may always answer in their own words instead, as with every ask.
const askQuestion = z
  .strictObject({
    header: oneLine(inboxTextLimits.header).nullable(),
    question: z.string().trim().min(1).max(inboxTextLimits.question),
    options: z
      .array(
        z.strictObject({
          label: line,
          summary: z.string().max(inboxTextLimits.summary).nullable(),
        }),
      )
      .min(1)
      .max(maxQuestionOptions),
    multiSelect: z.boolean(),
    recommend: z
      .number()
      .int()
      .min(0)
      .max(maxQuestionOptions - 1)
      .nullable(),
  })
  .refine(
    ({ options, recommend }) => recommend === null || recommend < options.length,
    "Recommend an offered option",
  )

const askShapes = [
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
    directory: oneLine(inboxTextLimits.directory).nullable(),
    doneLabel: line,
  }),
  z.strictObject({
    type: z.literal("questions"),
    questions: z.array(askQuestion).min(1).max(maxAskQuestions),
  }),
] as const
const askShape = z.discriminatedUnion("type", askShapes)

const askFields = {
  subject: line,
  body: markdown,
  details: markdown.nullable(),
  hardToUndo: z.string().max(inboxTextLimits.hardToUndo).nullable(),
}

// An ask as an agent puts it, which the runner parses as it is.
export const agentAsk = z.strictObject({ ...askFields, shape: askShape })

// An ask as a runner lists it to a UI, which reads a shape it doesn't know as `newer`: the
// ask stays, saying it needs a newer Novadeck to answer, and sends no answer.
const agentAskRead = z.strictObject({
  ...askFields,
  shape: openUnion("type", askShapes, { since: 3, unknown: "placeholder" }),
})

// The person's answer to an ask of options, words or an action (`inbox.answer`).
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

// The person's answers to an ask of several questions (`inbox.answerQuestions`), one per question
// in its order: the options picked, by index, and their own words; each question has one or the
// other, or both.
export const questionsAnswer = z
  .array(
    z.strictObject({
      options: z
        .array(
          z
            .number()
            .int()
            .min(0)
            .max(maxQuestionOptions - 1),
        )
        .max(maxQuestionOptions),
      text: z.string().max(4096),
    }),
  )
  .min(1)
  .max(maxAskQuestions)

// How an entry ended, and when: an ask answered in the Inbox (`answer` is what the person
// chose or wrote), dismissed there, or replied to by the person writing in its terminal; a
// tell or done read; any of them ended with its agent session or terminal. The runner keeps
// listing such an entry, resolved, as the Inbox's history; an ask its own agent withdrew is
// not listed.
const entrySettled = z.strictObject({
  how: z.enum(["answered", "dismissed", "replied", "read", "ended"]),
  at: z.number(),
  answer: z.string().max(inboxTextLimits.markdown).optional(),
})

const contentOptions = [
  z.strictObject({ kind: z.literal("ask"), ask: agentAskRead }),
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
] as const

// What an entry holds, as the runner keeps and parses it.
export const inboxContent = z.discriminatedUnion("kind", [
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
])

// What an entry holds, as a runner lists it to a UI, which reads a kind it doesn't know as
// `newer`: the entry stays in the Inbox, saying it needs a newer Novadeck.
const inboxContentRead = openUnion("kind", contentOptions, { since: 3, unknown: "placeholder" })

export const inboxEntry = z.strictObject({
  id,
  terminalId: id,
  projectId: id,
  workspaceSessionId: id,
  agent: agentNameRead,
  sessionId: z.string(),
  handle: z.string(),
  at: z.number(),
  content: inboxContentRead,
  // Only on an entry that is no longer open (see `entrySettled`).
  settled: entrySettled.optional(),
})

export type AgentAsk = z.infer<typeof agentAsk>
export type AskAnswer = z.infer<typeof askAnswer>
export type QuestionsAnswer = z.infer<typeof questionsAnswer>
export type InboxEntry = z.infer<typeof inboxEntry>
