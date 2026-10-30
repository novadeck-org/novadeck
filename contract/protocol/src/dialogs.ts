import { z } from "zod"

// How long each string a dialog shows may run, by the name of its field (a form field's
// `choices` are labels), and a raw dialog's text, in UTF-16 code units: what the runner
// reads off a screen is cut to these. Ids and counts are never cut.
export const dialogTextLimits = {
  title: 1024,
  detail: 4096,
  header: 256,
  question: 2048,
  label: 512,
  description: 2048,
  message: 2048,
} as const
export const maxRawDialogText = 4096

// What a request's dialog in the agent's TUI offers, as the harness's adapter read it from
// the terminal's screen, so the person can answer it from the chat (`agents.answer`):
// - `choices`: options to pick one of, as a permission or a plan approval offers. `text`
//   says an option takes the person's words: typed into the dialog's own field (`field`),
//   or sent as the agent's next prompt once the option is chosen (`prompt`).
// - `questions`: one or more questions, each with its options, whether several may be
//   picked, and whether the person may answer in their own words; and whether the person
//   may set them aside to talk it over first (`chat`): their words then reach the agent
//   typed into the dialog (`field`) or as its next prompt once the questions are set
//   aside (`prompt`); null where the harness offers no such way.
// - `form`: a form an MCP server asks the person to fill (an elicitation): its message,
//   and its fields, each text, a number, yes or no, or one of a set of choices, with
//   whether it must be filled. The person accepts it with their values, or declines it.
// - `raw`: a dialog is up for the request, but the adapter can't answer it safely: it
//   doesn't recognise it (`unrecognized`, as after an update changed the TUI), the harness
//   offers no way to answer it from outside (`unsupported`), or an answer was pressed and
//   the dialog didn't go as expected (`failed`). `text` is the screen's text around it,
//   for the person to read; they answer in the terminal.
// A readable dialog has an `id`, a fingerprint of what the runner read: an answer names
// it, and is refused, pressing nothing, when the dialog on screen no longer reads the same
// (an option renumbered as the terminal narrowed, another request's dialog in its place).
// `detail` is what the dialog shows of what it asks about (the tool's arguments, the
// permission asked for), as the terminal draws it, for the person to read. A command is the
// exception: it is the request's own command, exactly as it will run.
// Null while the dialog isn't on screen yet, or the request asks nothing on screen.
const dialogOption = z.strictObject({
  id: z.string().max(64),
  label: z.string().max(dialogTextLimits.label),
  text: z.enum(["field", "prompt"]).nullable(),
})
export const requestDialog = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("choices"),
    id: z.string().max(64),
    title: z.string().max(dialogTextLimits.title).nullable(),
    detail: z.string().max(dialogTextLimits.detail).nullable(),
    options: z.array(dialogOption).min(1).max(16),
  }),
  z.strictObject({
    type: z.literal("questions"),
    id: z.string().max(64),
    chat: z.enum(["field", "prompt"]).nullable(),
    questions: z
      .array(
        z.strictObject({
          id: z.string().max(64),
          header: z.string().max(dialogTextLimits.header).nullable(),
          question: z.string().max(dialogTextLimits.question),
          options: z
            .array(
              z.strictObject({
                id: z.string().max(64),
                label: z.string().max(dialogTextLimits.label),
                description: z.string().max(dialogTextLimits.description).nullable(),
              }),
            )
            .max(16),
          multiSelect: z.boolean(),
          text: z.boolean(),
        }),
      )
      .min(1)
      .max(8),
  }),
  z.strictObject({
    type: z.literal("form"),
    id: z.string().max(64),
    message: z.string().max(dialogTextLimits.message),
    fields: z
      .array(
        z.strictObject({
          id: z.string().max(128),
          label: z.string().max(dialogTextLimits.label),
          description: z.string().max(dialogTextLimits.description).nullable(),
          kind: z.enum(["text", "number", "boolean", "choice"]),
          choices: z.array(z.string().max(dialogTextLimits.label)).max(32),
          required: z.boolean(),
        }),
      )
      .max(16),
  }),
  z.strictObject({
    type: z.literal("raw"),
    text: z.string().max(maxRawDialogText),
    reason: z.enum(["unrecognized", "unsupported", "failed"]),
  }),
])

// The person's answer to a request's dialog, naming the dialog they answered by its `id`:
// one of its `choices` by id, with their words for an option that takes them; an answer
// per question, by ids, with the options picked and/or their own words; a `questions`
// dialog set aside to talk it over (`chat`), with the person's words (needed where its
// `chat` is `field`); or a form accepted with a value per field, by id, or declined.
export const requestAnswer = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("choice"),
    dialog: z.string().max(64),
    option: z.string().max(64),
    text: z.string().min(1).max(16_384).optional(),
  }),
  z.strictObject({
    type: z.literal("questions"),
    dialog: z.string().max(64),
    answers: z
      .array(
        z.strictObject({
          question: z.string().max(64),
          options: z.array(z.string().max(64)).max(16),
          text: z.string().min(1).max(16_384).optional(),
        }),
      )
      .min(1)
      .max(8),
  }),
  z.strictObject({
    type: z.literal("chat"),
    dialog: z.string().max(64),
    text: z.string().min(1).max(16_384).optional(),
  }),
  z.strictObject({
    type: z.literal("form"),
    dialog: z.string().max(64),
    action: z.enum(["accept", "decline"]),
    values: z
      .record(z.string().max(128), z.union([z.string().max(4096), z.number(), z.boolean()]))
      .refine((values) => Object.keys(values).length <= 16, "At most 16 fields"),
  }),
])

export type RequestDialog = z.infer<typeof requestDialog>
export type RequestAnswer = z.infer<typeof requestAnswer>
