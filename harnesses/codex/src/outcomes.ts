import { isFields, parseFields, type Fields } from "@novadeck/harness-core/fields"
import {
  addedFile,
  deletedFile,
  exited,
  hunkChange,
  hunksOf,
  joinedChange,
  outcome,
} from "@novadeck/harness-core/outcomes"
import type { ToolChange, ToolOutcome } from "@novadeck/protocol"

import { patchChange } from "./patch.js"

// The header Codex writes above a command's output, as 0.158 to 0.167 do: the process's end, or
// that it runs on. A patch run by a tool or its shell, the same in other words, the shell's
// inside a header of its own. A patch that didn't apply says so with no header at all; a
// script, what became of the script alone: a command inside it failing leaves it `completed`.
const commandHeader =
  /^(?:Chunk ID: [^\n]*\n)?Wall time: [^\n]*\nProcess (?:exited with code (-?\d+)|running with session ID \d+)\n/
const patchHeader =
  /^(?:Wall time: [^\n]*\nOutput:\n)?Exit code: (-?\d+)\nWall time: [^\n]*\nOutput:\n/
const patchRefused = /^apply_patch verification failed/
const scriptFailed = /^Script failed\n/
const scriptRuns = /^Script running with cell ID \d+\n/

/** What a tool's output says of its call, in Codex's own words where it has any. */
export const outputOutcome = (output: string): ToolOutcome | null => {
  const command = commandHeader.exec(output)
  if (command)
    return command[1] === undefined ? outcome({ running: true }) : exited(Number(command[1]))
  const patch = patchHeader.exec(output)
  if (patch) return exited(Number(patch[1]))
  if (patchRefused.test(output) || scriptFailed.test(output)) return outcome({ failed: true })
  return scriptRuns.test(output) ? outcome({ running: true }) : null
}

/**
 * The lines a call's input says it changes: a patch, given to `apply_patch` or to a shell as
 * `apply_patch <<EOF`.
 */
export const callChange = (tool: unknown, input: string): ToolOutcome | null => {
  const fields = parseFields(input)
  const command = typeof fields?.cmd === "string" ? fields.cmd : undefined
  const patch =
    tool === "apply_patch"
      ? typeof fields?.input === "string"
        ? fields.input
        : input
      : tool === "exec_command" && command?.trimStart().startsWith("apply_patch")
        ? command
        : undefined
  const change = patch === undefined ? null : patchChange(patch)
  return change ? outcome({ change }) : null
}

// A status of Codex's own for a command or a file change, as the app-server names them.
const failedOf = (status: unknown): boolean | null =>
  status === "failed" ? true : status === "completed" ? false : null

// The lines a read gave, where Codex itself took the command for one read and nothing else.
const linesRead = (item: Fields): ToolOutcome["size"] => {
  const { parsed_cmd: parsed, aggregated_output: output, exit_code: code } = item
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof output !== "string" || code !== 0)
    return null
  if (!isFields(parsed[0]) || parsed[0].type !== "read") return null
  const lines = output.split("\n")
  return { count: lines.length - (lines.at(-1) === "" ? 1 : 0), unit: "line" }
}

/** What a `CommandExecution` item says of its command. */
export const commandOutcome = (item: Fields): ToolOutcome =>
  outcome({
    failed: failedOf(item.status),
    exit: Number.isInteger(item.exit_code) ? (item.exit_code as number) : null,
    size: linesRead(item),
  })

// What a `FileChange` item says of one file.
const fileChange = (change: unknown): ToolChange | null => {
  if (!isFields(change)) return null
  const { type, content, unified_diff: diff } = change
  if (type === "add" && typeof content === "string") return addedFile(content)
  if (type === "delete" && typeof content === "string") return deletedFile(content)
  return type === "update" && typeof diff === "string" ? hunkChange(hunksOf(diff)) : null
}

/** What a `FileChange` item says of its patch, once it applied. */
export const fileChangeOutcome = (item: Fields): ToolOutcome => {
  const parts = isFields(item.changes) ? Object.values(item.changes).map(fileChange) : []
  const known = parts.length > 0 && parts.every((part) => part !== null)
  return outcome({
    failed: failedOf(item.status),
    change: known ? joinedChange(parts as ToolChange[]) : null,
  })
}
