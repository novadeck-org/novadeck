import { reportedOr, sessionName } from "@novadeck/harness-core/conversation"
import { fieldsOf, parseFields, type Fields } from "@novadeck/harness-core/fields"
import type {
  ImageSource,
  TranscriptDecoder,
  TranscriptEntry,
  UserEntry,
} from "@novadeck/harness-core/harness"
import { entry, noteEntry, noticeEntries, textOf, withImages } from "@novadeck/harness-core/items"
import { addedFile, exited, hunkChange, hunksOf, outcome } from "@novadeck/harness-core/outcomes"
import { flavourOf } from "@novadeck/harness-core/paths"
import { isDelivery } from "@novadeck/protocol/harnesses"

import { describe } from "./tools.js"

/**
 * One line of a session's transcript, as Novadeck's plugin writes it beside itself
 * (plugin-source.ts): opencode keeps its sessions in a database of its own, so the plugin
 * writes each record once it is final, as opencode's own events give it: a prompt whole, its
 * words and attachments together (`prompt`), an answer's info once it is done (`message`), and
 * each part of an answer (`part`) with its author (`role`), which a part doesn't name. A resumed session's records from before are written first, from opencode's
 * own list of its messages. The parts are opencode's MessageV2 parts as 1.19.6 sends them.
 */
type Line =
  | { readonly type: "message"; readonly info: Fields }
  | { readonly type: "prompt"; readonly info: Fields; readonly parts: readonly Fields[] }
  | {
      readonly type: "part"
      readonly role: string | null
      readonly part: Fields
      /** A tool call written as it started, with no result yet. */
      readonly call?: true
      /** A tool part that ended, whose call was written as it started. */
      readonly called?: true
    }

/** A transcript line's record, where it is one of the two. */
export const lineOf = (line: string): Line | undefined => {
  const fields = parseFields(line)
  if (!fields) return undefined
  if (fields.type === "message") {
    const info = fieldsOf(fields.info)
    return info ? { type: "message", info } : undefined
  }
  if (fields.type === "prompt") {
    const info = fieldsOf(fields.info)
    const parts = (Array.isArray(fields.parts) ? fields.parts : []).flatMap((one): Fields[] => {
      const part = fieldsOf(one)
      return part ? [part] : []
    })
    return info ? { type: "prompt", info, parts } : undefined
  }
  if (fields.type === "part") {
    const part = fieldsOf(fields.part)
    const role = typeof fields.role === "string" ? fields.role : null
    return part
      ? {
          type: "part",
          role,
          part,
          ...(fields.call === true && { call: true as const }),
          ...(fields.called === true && { called: true as const }),
        }
      : undefined
  }
  return undefined
}

/** When a part was written: its end, where it streamed, else its start. */
const timeOf = (part: Fields): number | null => {
  const time = fieldsOf(part.time) ?? fieldsOf(fieldsOf(part.state)?.time)
  const end = time?.end
  const start = time?.start
  return typeof end === "number" ? end : typeof start === "number" ? start : null
}

// An image the person attached, as a part of their message: a `file` part of an image's type,
// whose url holds its bytes (`data:image/png;base64,…`) or names its file (`file://…`).
const imageOf = (part: Fields): ImageSource | undefined => {
  if (part.type !== "file") return undefined
  const mime = typeof part.mime === "string" ? part.mime : null
  if (mime !== null && !mime.startsWith("image/")) return undefined
  const url = typeof part.url === "string" ? part.url : ""
  const data = /^data:([^;,]*)?;base64,(.*)$/s.exec(url)
  if (data) return { mime: mime ?? data[1] ?? null, base64: data[2]! }
  if (/^file:\/\//i.test(url)) {
    try {
      const path = decodeURIComponent(new URL(url).pathname)
      return { mime, file: /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path }
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * What came of a tool call, from its part's state: an error is a failure (a refused
 * permission's among them, "The user rejected permission…"); bash's exit code, where its
 * metadata gives one.
 */
// What bash says, at the end of its output, of a command it stopped at its timeout.
const timedOut = /<shell_metadata>\s*shell tool terminated command after exceeding timeout/

const toolOutcome = (tool: unknown, state: Fields) => {
  if (state.status === "error") return outcome({ failed: true })
  const metadata = fieldsOf(state.metadata)
  // A command stopped at its timeout is a completed call with no exit code of its own (probed
  // 2026-11-22, 1.19.6): it failed.
  if (tool === "bash" && typeof state.output === "string" && timedOut.test(state.output))
    return outcome({ failed: true })
  // An edit's and a patch's change, as the unified diff opencode keeps beside it.
  const diff = typeof metadata?.diff === "string" ? metadata.diff : undefined
  if (diff !== undefined && (tool === "edit" || tool === "multiedit" || tool === "apply_patch"))
    return outcome({ failed: false, change: hunkChange(hunksOf(diff)) })
  // A new file's change is all its lines; one written over says nothing of what was there.
  const content = fieldsOf(state.input)?.content
  if (tool === "write" && metadata?.exists === false && typeof content === "string")
    return outcome({ failed: false, change: addedFile(content) })
  return typeof metadata?.exit === "number" ? exited(metadata.exit) : outcome({ failed: false })
}

const partItems = (
  role: string | null,
  part: Fields,
  written: { readonly call?: true; readonly called?: true } = {},
): readonly TranscriptEntry[] => {
  const time = timeOf(part)
  switch (part.type) {
    case "text": {
      const text = typeof part.text === "string" ? part.text : ""
      if (!text.trim()) return []
      if (role === "user") {
        // What the plugin added to a prompt: a delivery of agents' messages, which the chat
        // reads apart, or Novadeck's standing notices.
        if (part.synthetic === true)
          return isDelivery(text)
            ? [entry("user", "text", text, { at: time })]
            : noticeEntries(text, time)
        return [entry("user", "text", text, { at: time })]
      }
      if (role === "assistant" && part.synthetic !== true)
        return [entry("assistant", "text", text, { at: time })]
      return []
    }
    case "tool": {
      const state = fieldsOf(part.state)
      if (!state) return []
      const call = typeof part.callID === "string" ? part.callID : undefined
      const tool = part.tool
      const result =
        state.status === "error"
          ? textOf(state.error)
          : typeof state.output === "string"
            ? state.output
            : ""
      const asked = entry("assistant", "tool-call", textOf(state.input ?? {}), {
        at: time,
        tool,
        call,
        describe,
      })
      // As it starts, the call alone, which the chat shows running until its result comes.
      if (written.call) return [asked]
      const ended = entry("tool", "tool-result", result, {
        at: time,
        call,
        outcome: toolOutcome(tool, state),
      })
      return written.called ? [ended] : [asked, ended]
    }
    case "compaction":
      return [noteEntry({ type: "compaction" }, time)]
    default:
      return []
  }
}

/**
 * The transcript Novadeck's plugin writes for a session: the person's prompts and the images
 * they attached, the agent's words, and each tool call with its result, the two from one
 * part, as opencode keeps a call and its result together. Its reasoning, its steps' starts and
 * ends, its snapshots and patches stay out. A prompt says which agent it went to, so leaving
 * or entering its plan agent shows. A subagent's session is a transcript of its own, beside.
 */
export const transcripts: TranscriptDecoder = {
  locate: async (reported, sessionId, subagent) => {
    if (subagent === null) return reportedOr(reported, sessionId, async () => undefined)
    if (!sessionName.test(subagent.replace(/^ses_/, ""))) return undefined
    const rules = flavourOf(reported)
    return rules.join(rules.dirname(reported), `${subagent}.jsonl`)
  },
  images: (line) => {
    const read = lineOf(line)
    return read?.type === "prompt" ? read.parts.flatMap((part) => imageOf(part) ?? []) : []
  },
  items: (line) => {
    const read = lineOf(line)
    if (!read) return []
    if (read.type === "message") return []
    if (read.type === "part") return partItems(read.role, read.part, read)
    const { info, parts } = read
    const created = fieldsOf(info.time)?.created
    const at = typeof created === "number" ? created : null
    const words = parts.flatMap((part) =>
      partItems("user", { ...part, time: part.time ?? { start: at } }),
    )
    return [
      // A prompt says which agent it went to: its plan agent plans.
      ...(typeof info.agent === "string"
        ? [noteEntry({ type: "mode", mode: info.agent === "plan" ? "plan" : "not-plan" }, at)]
        : []),
      ...withImages(
        words,
        parts.flatMap((part) => {
          const image = imageOf(part)
          return image ? [image.mime] : []
        }),
      ),
    ]
  },
}

/** What one transcript line records as typed into the box: the person's own words of a prompt. */
export const typedEntry = (line: string): UserEntry | undefined => {
  const read = lineOf(line)
  if (read?.type !== "prompt") return undefined
  const text = read.parts
    .filter(
      (part) => part.type === "text" && part.synthetic !== true && typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("\n")
  if (!text) return undefined
  const created = fieldsOf(read.info.time)?.created
  return { text, at: typeof created === "number" ? created : null, id: null }
}
