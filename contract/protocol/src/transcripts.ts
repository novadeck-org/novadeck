import { z } from "zod"

import { agentRef } from "./agents.js"

// How long an item's text runs at most, and a tool's or an author's name, in UTF-16 code
// units, and how many items one change carries.
export const transcriptLimits = { text: 16_384, name: 256, items: 256 } as const

// How many diff lines a tool's outcome carries at most, and how long one runs, in UTF-16 code
// units: the first of the change, which `added` and `removed` count whole.
export const outcomeLimits = { lines: 40, lineText: 512 } as const

// What a tool call was, as its harness's decoder says: the chat's one line for it. Both
// strings are bounded as the item's own text is, since they are derived from it.
export const toolRun = z.strictObject({
  kind: z.enum(["run", "read", "write", "search", "web", "agent", "plan", "other"]),
  // What the tool is called to a person: "Ran", "Edited", "Messaged @fox", or an unknown
  // tool's own name.
  title: z.string().max(transcriptLimits.text),
  // What it was called on: the command, the file, the pattern. Empty where there is none.
  detail: z.string().max(transcriptLimits.text),
})
// The lines a tool changed, as its harness records them or as the call's input says, read
// before any cut. `added` and `removed` count the whole change; `lines` hold its first lines:
// "+", "-" or " " for a line around them. `line` is its number in the file where the harness
// records one (a removed line's in the file before, any other's after), else null.
export const toolChange = z.strictObject({
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  lines: z
    .array(
      z.strictObject({
        sign: z.enum(["+", "-", " "]),
        text: z.string().max(outcomeLimits.lineText),
        line: z.number().int().positive().nullable(),
      }),
    )
    .max(outcomeLimits.lines),
})

// What came of a tool call, in its harness's own words and never read from what a tool
// printed; every part is null where the harness doesn't say. `failed` is its word on the
// call, `exit` a command's exit code, `running` that the call goes on past this result (a
// command in the background, whose `failed` is then unknown), `size` a count it states, and
// `change` the lines it changed. A call's item carries what its input says, as `change`; its
// result's the rest: the two make one outcome by `call`.
export const toolOutcome = z.strictObject({
  failed: z.boolean().nullable(),
  exit: z.number().int().nullable(),
  running: z.boolean(),
  size: z
    .strictObject({
      count: z.number().int().nonnegative(),
      unit: z.enum(["line", "match", "file"]),
    })
    .nullable(),
  change: toolChange.nullable(),
})

// `agents.transcript` changes: items of an actor's conversation in the order its harness
// recorded them, numbered from the start of the record (a tool's result may come before
// its call, which `call` pairs it with); or `reset`, when the record
// was rewritten and its items follow again from the start. An item is the person's or
// the agent's text, another agent's message to it (`author` names that agent, in its
// harness's words), a tool call, with its input as text, or a tool's result; `call`
// pairs a result with its call, `run` says what a call was, and `outcome` what came of it.
// `scripted` marks a call its harness made inside a script of the agent's, recorded after the
// script's own call. Text past 16 KiB is cut short and marked `truncated`. Private reasoning
// is never included. `unread` says, once,
// that the record holds a part of the conversation its decoder has never seen, which the
// items leave out: the terminal shows it.
// The refinement on an item makes `.pick`, `.omit` and `.partial` of it throw; `.extend` works.
export const transcriptItem = z
  .strictObject({
    index: z.number().int().nonnegative(),
    at: z.number().nullable(),
    role: z.enum(["user", "assistant", "agent", "tool"]),
    kind: z.enum(["text", "tool-call", "tool-result"]),
    text: z.string().max(transcriptLimits.text),
    truncated: z.boolean(),
    tool: z.string().max(transcriptLimits.name).nullable(),
    call: agentRef.nullable(),
    author: z.string().max(transcriptLimits.name).nullable(),
    // On a tool call, what it was; null on every other item.
    run: toolRun.nullable(),
    // On a tool call or its result, what came of it, where its harness says; null otherwise.
    outcome: toolOutcome.nullable(),
    // A tool call made inside a script of the agent's, and its result.
    scripted: z.boolean(),
    // A `user` item that records a stopped turn.
    interrupted: z.boolean(),
  })
  .refine((item) => (item.run !== null) === (item.kind === "tool-call"), {
    message: "A tool call has a run, and no other item does",
    path: ["run"],
  })
  .refine((item) => item.outcome === null || item.kind !== "text", {
    message: "Only a tool call or its result has an outcome",
    path: ["outcome"],
  })
export const transcriptChange = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("items"),
    items: z.array(transcriptItem).min(1).max(transcriptLimits.items),
  }),
  z.strictObject({ type: z.literal("reset") }),
  z.strictObject({ type: z.literal("unread") }),
])

export type TranscriptItem = z.infer<typeof transcriptItem>
export type ToolRun = z.infer<typeof toolRun>
export type ToolChange = z.infer<typeof toolChange>
export type ToolOutcome = z.infer<typeof toolOutcome>
export type TranscriptChange = z.infer<typeof transcriptChange>
