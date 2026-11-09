import { readdir } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import {
  homeOfTranscript,
  presence,
  reportedOr,
  sessionName,
} from "@novadeck/harness-core/conversation"
import { isFields, parseFields } from "@novadeck/harness-core/fields"
import type { TranscriptDecoder, TranscriptEntry } from "@novadeck/harness-core/harness"
import { at, entry, joined, noteEntry, textOf } from "@novadeck/harness-core/items"
import { outcome } from "@novadeck/harness-core/outcomes"
import { shellCall } from "@novadeck/harness-core/tools"

import { taskNotification } from "./decode.js"
import { interruption } from "./interruption.js"
import { outcomeOf } from "./outcomes.js"
import { describe } from "./tools.js"

// A subagent id Claude Code names its transcript by, as it writes them.
const safeId = /^[\w-]{1,128}$/

/**
 * The session's transcript in another project of the home the reported path names:
 * Claude Code keeps a session in the folder of the project it began in, and a resume in
 * another folder reports that folder's project (probed 2026-11-07, 2.1.319) while it goes
 * on writing the first. One listing of the projects and a `stat` in each.
 */
const inOtherProject = async (reported: string, sessionId: string): Promise<string | undefined> => {
  const file = `${sessionId}.jsonl`
  const home = homeOfTranscript(reported, "projects")
  if (!sessionName.test(sessionId) || basename(reported) !== file || home === undefined)
    return undefined
  const projects = join(home, "projects")
  const names = await readdir(projects).catch(() => [])
  const found = await Promise.all(
    names.map(async (name) => {
      const path = join(projects, name, file)
      return path !== reported && (await presence(path)) === "present" ? path : undefined
    }),
  )
  return found.find((path) => path !== undefined)
}

/**
 * Claude Code's transcripts: the session's JSONL, and beside it a folder named for the
 * session with a JSONL per subagent. Each user or assistant record holds its message's
 * text, tool calls and tool results; thinking stays out, as do the records Claude Code
 * writes for itself (`isMeta`), its compaction summaries, and the notices of background
 * tasks it hands the model as the person's message. A command the person runs in shell
 * mode (`!`) is two user records, the command and then its output, which read as the
 * person's `!command` and a Bash run (the output's record names the command's as its
 * parent, so they pair). A prompt the person gives while a turn runs, which Claude Code
 * takes into that turn beside a tool's result, is no user record but an attachment of the
 * turn (see `queuedPrompt`); it reads as the person's prompt all the same.
 */

// Agents' messages Novadeck handed the agent as a prompt of their own (as 2.1.294 wrote
// them), which are no words of the person's.
const delivery = /^\s*<novadeck-messages[\s>]/

// A shell-mode command, as `<bash-input>`; its output follows as stdout and stderr, which
// hold what the command printed, however it ended (a failed one's output is in stderr). A
// command Claude Code couldn't start at all, as in a folder since deleted, writes stderr alone.
const shellInput = /^<bash-input>([\s\S]*)<\/bash-input>$/
const shellOutput =
  /^(?:<bash-stdout>([\s\S]*)<\/bash-stdout>(?=<bash-stderr>|$))?(?:<bash-stderr>([\s\S]*)<\/bash-stderr>)?$/

/**
 * A paste Claude Code wrapped in the person's prompt (`<pasted_content id="…">`, seen on
 * 2.1.302 to 2.1.316 for some pastes of any size, never in the e2e sandbox), set off from
 * the typed words around it by line breaks. The tag repeats its id on the closing side, as
 * every one seen does; one that doesn't is read the same.
 */
const pasted =
  /\n{0,2}<pasted_content id="([^"\n]*)">\n([\s\S]*?)\n<\/pasted_content(?: id="\1")?>\n?/g

/**
 * The person's words with each paste Claude Code wrapped in them (`<pasted_content>`) put
 * back as it was pasted: the text the chat shows, and the text a sent prompt matches.
 */
export const unwrapPasted = (text: string): string => text.replace(pasted, (_, _id, body) => body)

/** Whether a text holds a paste Claude Code wrapped. */
export const holdsPaste = (text: string): boolean => {
  pasted.lastIndex = 0
  return pasted.test(text)
}

/**
 * A slash command the person ran, as Claude Code writes it down: a user record of its
 * name, message and arguments (in either order), then one of what it printed, behind a
 * caveat of its own (`isMeta`). The terminal shows the command as the line typed and its
 * output below it; the chat does the same, the command as the person's words and the output
 * as a folded result, unless it printed nothing.
 */
const commandTag = /<(command-name|command-message|command-args)>([\s\S]*?)<\/\1>/g
const commandRecord = /^\s*<(?:command-name|command-message)>/
const commandOutput = /^\s*<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>\s*$/
// eslint-disable-next-line no-control-regex -- The output keeps the terminal's styles and moves as ANSI codes.
const ansi = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

// The command line a slash command's record holds: `/name args`.
const commandLine = (content: string): string => {
  const parts = new Map([...content.matchAll(commandTag)].map((match) => [match[1], match[2]!]))
  const named =
    parts.get("command-name")?.trim() || `/${parts.get("command-message")?.trim() ?? ""}`
  const args = parts.get("command-args")?.trim()
  return args ? `${named} ${args}` : named
}

/**
 * The person's prompt that a `queued_command` attachment carries, and when they gave it:
 * Claude Code writes one for a prompt it takes into the running turn, as a tool's result
 * comes, rather than as a turn of its own (since at least 2.1.289; its queue logs `absorbed_mid_turn`).
 * Only a human origin is the person's: a background task's notice, a peer's or a
 * coordinator's message comes the same way, as do Claude Code's own (`isMeta`), and an
 * attachment that names no origin is left out with them. A prompt with an image is a list
 * of blocks, whose text reads as the prompt.
 */
export const queuedPrompt = (
  fields: Record<string, unknown>,
): { readonly text: string; readonly at: unknown } | undefined => {
  const queued = (fields.attachment ?? {}) as Record<string, unknown>
  const { origin, commandMode: mode, prompt } = queued
  if (
    queued.type !== "queued_command" ||
    queued.isMeta === true ||
    (origin as { kind?: unknown } | undefined)?.kind !== "human" ||
    (mode !== undefined && mode !== "prompt")
  )
    return undefined
  const text = typeof prompt === "string" ? prompt : joined(prompt, ["text"])
  return { text, at: queued.timestamp ?? fields.timestamp }
}

const tagged = (text: string, tag: string): string | undefined =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1]?.trim()

// A subagent's task notice as the result of the call that started it, which pairs with it by
// the call's id: its report, or where it has none its summary. A notice of any other task (a
// command, a monitor) stays out of the chat.
const notified = (notice: string, time: number | null): TranscriptEntry[] => {
  const call = tagged(notice, "tool-use-id")
  const report = tagged(notice, "result")
  const summary = tagged(notice, "summary")
  const text = report ?? (summary && /^Agent\b/.test(summary) ? summary : undefined)
  if (!call || !text) return []
  const status = tagged(notice, "status")
  return [
    entry("tool", "tool-result", text, {
      at: time,
      call,
      outcome: outcome({ failed: status === "failed" || status === "killed" }),
    }),
  ]
}

// The items of a record's text content: the person's shell-mode command or its output, or
// the text itself unless it is a background task's notice.
const textItems = (
  role: "user" | "assistant",
  written: string,
  time: number | null,
  fields: Record<string, unknown>,
): TranscriptEntry[] => {
  const content = role === "user" ? unwrapPasted(written) : written
  const command = role === "user" ? shellInput.exec(content)?.[1] : undefined
  if (command !== undefined)
    return [
      entry("user", "text", `!${command}`, { at: time }),
      entry("assistant", "tool-call", JSON.stringify({ command }), {
        at: time,
        tool: "Bash",
        call: fields.uuid,
        describe: shellCall,
      }),
    ]
  if (role === "user" && commandRecord.test(content))
    return [entry("user", "text", commandLine(content), { at: time })]
  const printed = role === "user" ? commandOutput.exec(content)?.[2] : undefined
  if (printed !== undefined) {
    const text = printed.replace(ansi, "").trim()
    return text && text !== "(no content)"
      ? [entry("tool", "tool-result", text, { at: time, call: fields.parentUuid })]
      : []
  }
  const output = role === "user" && content ? shellOutput.exec(content) : null
  if (output && (output[1] !== undefined || output[2] !== undefined))
    return [
      entry(
        "tool",
        "tool-result",
        output
          .slice(1, 3)
          .map((each) => (each ?? "").replace(ansi, "").trimEnd())
          .filter(Boolean)
          .join("\n"),
        { at: time, call: fields.parentUuid },
      ),
    ]
  if (role === "user" && taskNotification.test(content)) return notified(content, time)
  return content && !taskNotification.test(content) && !delivery.test(content)
    ? [entry(role, "text", content, { at: time, interrupted: interruption(content) })]
    : []
}

// What its record says of the permission mode: on the record of each prompt, as it was then,
// and on the `permission-mode` record it writes as a turn ends, so a change made mid-turn, as a
// plan approved with auto-accept, shows there (probed 2026-11-07, 2.1.316).
const modeNote = (mode: unknown, time: number | null): readonly TranscriptEntry[] =>
  typeof mode === "string" && mode ? [noteEntry({ type: "mode", mode }, time)] : []

// The words of the result of an ExitPlanMode the person approved, in place of any other mark.
const planApproved = /^User has approved your plan\b/

export const transcripts: TranscriptDecoder = {
  locate: async (reported, sessionId, subagent) => {
    const root = await reportedOr(reported, sessionId, () => inOtherProject(reported, sessionId))
    if (subagent === null) return root
    if (!safeId.test(subagent) || !safeId.test(sessionId)) return undefined
    return join(dirname(root), sessionId, "subagents", `agent-${subagent}.jsonl`)
  },
  items: (line) => {
    const fields = parseFields(line)
    if (!fields || fields.isMeta === true) return []
    if (fields.isCompactSummary === true) {
      const summary = (fields.message as { content?: unknown } | undefined)?.content
      const text = typeof summary === "string" ? summary : joined(summary, ["text"])
      return [noteEntry({ type: "compaction" }, at(fields.timestamp), text)]
    }
    if (fields.type === "permission-mode") return modeNote(fields.permissionMode, null)
    if (fields.type === "attachment") {
      const queued = queuedPrompt(fields)
      return queued ? textItems("user", queued.text, at(queued.at), fields) : []
    }
    const role = fields.type
    if (role !== "user" && role !== "assistant") return []
    const time = at(fields.timestamp)
    const content = (fields.message as { content?: unknown } | undefined)?.content
    const mode = role === "user" ? modeNote(fields.permissionMode, time) : []
    if (typeof content === "string") return [...mode, ...textItems(role, content, time, fields)]
    const parts = Array.isArray(content) ? content : []
    // The record's detail of a result speaks for one result alone.
    const results = parts.filter((part) => isFields(part) && part.type === "tool_result")
    const items = parts.flatMap((part) => {
      const {
        type,
        text,
        name,
        input,
        id,
        content: result,
        tool_use_id: call,
        is_error: failed,
      } = (part ?? {}) as Record<string, unknown>
      // The person's text block reads as their text content does, wrappers and all.
      if (type === "text" && typeof text === "string" && text)
        return role === "user"
          ? textItems(role, text, time, fields)
          : [entry(role, "text", text, { at: time, interrupted: interruption(text) })]
      if (type === "tool_use")
        return [
          entry("assistant", "tool-call", textOf(input), {
            at: time,
            tool: name,
            call: id,
            describe,
          }),
        ]
      if (type === "tool_result") {
        const output = typeof result === "string" ? result : joined(result, ["text"])
        return [
          entry("tool", "tool-result", output, {
            at: time,
            call,
            outcome: outcomeOf(
              failed === true,
              output,
              results.length === 1 ? fields.toolUseResult : undefined,
            ),
          }),
          ...(planApproved.test(output) ? [noteEntry({ type: "plan-approved" }, time)] : []),
        ]
      }
      return []
    })
    return [...mode, ...items]
  },
}
