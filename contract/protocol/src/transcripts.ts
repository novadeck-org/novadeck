import { z } from "zod"

import { agentRef } from "./agents.js"

// What a tool call was, as its harness's decoder says: the chat's one line for it. Both
// strings are bounded as the item's own text is, since they are derived from it.
export const toolRun = z.strictObject({
  kind: z.enum(["run", "read", "write", "search", "web", "agent", "plan", "other"]),
  // What the tool is called to a person: "Ran", "Edited", "Messaged @fox", or an unknown
  // tool's own name.
  title: z.string().max(16_384),
  // What it was called on: the command, the file, the pattern. Empty where there is none.
  detail: z.string().max(16_384),
})
// `agents.transcript` changes: items of an actor's conversation in the order its harness
// recorded them, numbered from the start of the record (a tool's result may come before
// its call, which `call` pairs it with); or `reset`, when the record
// was rewritten and its items follow again from the start. An item is the person's or
// the agent's text, another agent's message to it (`author` names that agent, in its
// harness's words), a tool call, with its input as text, or a tool's result; `call`
// pairs a result with its call, and `run` says what a call was. Text past 16 KiB is cut
// short and marked `truncated`. Private reasoning is never included.
// The refinement on an item makes `.pick`, `.omit` and `.partial` of it throw; `.extend` works.
export const transcriptItem = z
  .strictObject({
    index: z.number().int().nonnegative(),
    at: z.number().nullable(),
    role: z.enum(["user", "assistant", "agent", "tool"]),
    kind: z.enum(["text", "tool-call", "tool-result"]),
    text: z.string().max(16_384),
    truncated: z.boolean(),
    tool: z.string().max(256).nullable(),
    call: agentRef.nullable(),
    author: z.string().max(256).nullable(),
    // On a tool call, what it was; null on every other item.
    run: toolRun.nullable(),
    // A user item that records a stopped turn.
    interrupted: z.boolean(),
  })
  .refine((item) => (item.run !== null) === (item.kind === "tool-call"), {
    message: "A tool call has a run, and no other item does",
    path: ["run"],
  })
export const transcriptChange = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("items"), items: z.array(transcriptItem).min(1).max(256) }),
  z.strictObject({ type: z.literal("reset") }),
])

export type TranscriptItem = z.infer<typeof transcriptItem>
export type ToolRun = z.infer<typeof toolRun>
export type TranscriptChange = z.infer<typeof transcriptChange>
