import {
  transcriptLimits,
  type ToolOutcome,
  type ToolRun,
  type TranscriptItem,
  type TranscriptNote,
} from "@novadeck/protocol"

import { cutText, ref } from "./decode.js"
import type { TranscriptEntry } from "./harness.js"
import { ringOf } from "./prompts.js"

/** When a record was written, from its ISO timestamp. */
export const at = (value: unknown): number | null => {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isNaN(time) ? null : time
}

/** A value as text: itself when it is text, JSON otherwise. */
export const textOf = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "")

/** The text parts of a harness's content list, joined. */
export const joined = (parts: unknown, types: readonly string[]): string =>
  (Array.isArray(parts) ? parts : [])
    .map((part) => part as { type?: unknown; text?: unknown } | null)
    .filter((part) => types.includes(String(part?.type)) && typeof part?.text === "string")
    .map((part) => part!.text as string)
    .join("\n")

type Describe = (tool: string, input: string) => ToolRun

type EntryFields = {
  readonly at: number | null
  readonly tool?: unknown
  readonly call?: unknown
  readonly author?: unknown
  /**
   * Whether a user's text records that the person interrupted the turn, as its harness
   * tells by its own record of it; the chat shows it as a note.
   */
  readonly interrupted?: boolean
  /** On a tool call or its result, what came of it, as the decoder read it from the record. */
  readonly outcome?: ToolOutcome | null
  /** On a tool call and its result, that the harness made the call inside an agent's script. */
  readonly scripted?: boolean
}

/**
 * An item, bounded as the protocol takes it; a tool call's native id becomes a ref. A
 * call's `run` comes from the harness's `describe`, which reads the call as the item carries
 * it: its input cut to 16 KiB and its name to 256 characters, a call with no name being "tool".
 * A tool call can't be made without one: the overload for it requires `describe`, so a
 * decoder path that forgets it doesn't compile.
 */
export function entry(
  role: TranscriptItem["role"],
  kind: "text" | "tool-result",
  text: string,
  fields: EntryFields,
): TranscriptEntry
export function entry(
  role: TranscriptItem["role"],
  kind: "tool-call",
  text: string,
  fields: EntryFields & { readonly describe: Describe },
): TranscriptEntry
export function entry(
  role: TranscriptItem["role"],
  kind: TranscriptItem["kind"],
  text: string,
  fields: EntryFields & { readonly describe?: Describe },
): TranscriptEntry {
  const cut = cutText(text, transcriptLimits.text)
  const tool = typeof fields.tool === "string" ? cutText(fields.tool, transcriptLimits.name) : null
  return {
    at: fields.at,
    role,
    kind,
    text: cut,
    truncated: text.length > transcriptLimits.text,
    tool,
    call: typeof fields.call === "string" && fields.call ? ref("call", fields.call) : null,
    author:
      typeof fields.author === "string" && fields.author
        ? cutText(fields.author, transcriptLimits.name)
        : null,
    run: kind === "tool-call" ? (fields.describe?.(tool ?? "tool", cut) ?? null) : null,
    outcome: kind === "text" ? null : (fields.outcome ?? null),
    scripted: kind !== "text" && fields.scripted === true,
    interrupted: role === "user" && kind === "text" && fields.interrupted === true,
    ring: role === "user" && kind === "text" ? ringOf(cut) : null,
  }
}

/**
 * The entries with the line's images on the first of the person's texts, which holds the
 * image's place (`[Image #1]`); none where it has no such text, as the images then have no
 * words to stand with.
 */
export const withImages = (
  entries: readonly TranscriptEntry[],
  mimes: readonly (string | null)[],
): readonly TranscriptEntry[] => {
  const first = entries.findIndex(
    (each) => each.role === "user" && each.kind === "text" && !each.interrupted,
  )
  if (mimes.length === 0 || first === -1) return entries
  return entries.map((each, place) =>
    place === first ? { ...each, images: mimes.map((mime, index) => ({ index, mime })) } : each,
  )
}

/** What a harness recorded between turns, as an item: `text` is a compaction's summary. */
export const noteEntry = (
  note: TranscriptNote,
  when: number | null,
  text = "",
): TranscriptEntry => ({
  ...entry("note", "text", text, { at: when }),
  note,
})

/**
 * The item that shows where the person interrupted a turn, for a harness whose records hold
 * no interruption of their own (Antigravity's): the runner joins it to the transcript's
 * items, read as a harness's own record of one reads.
 */
export const interruptionEntry = (when: number): TranscriptEntry => ({
  at: when,
  role: "user",
  kind: "text",
  text: "Interrupted",
  truncated: false,
  tool: null,
  call: null,
  author: null,
  run: null,
  outcome: null,
  scripted: false,
  interrupted: true,
  ring: null,
})
