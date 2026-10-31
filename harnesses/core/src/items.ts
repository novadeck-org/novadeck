import { transcriptLimits, type ToolRun, type TranscriptItem } from "@novadeck/protocol"

import { ref } from "./decode.js"
import type { TranscriptEntry } from "./harness.js"

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
  const cut = text.slice(0, transcriptLimits.text)
  const tool = typeof fields.tool === "string" ? fields.tool.slice(0, transcriptLimits.name) : null
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
        ? fields.author.slice(0, transcriptLimits.name)
        : null,
    run: kind === "tool-call" ? (fields.describe?.(tool ?? "tool", cut) ?? null) : null,
    interrupted: role === "user" && kind === "text" && fields.interrupted === true,
  }
}

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
  interrupted: true,
})
