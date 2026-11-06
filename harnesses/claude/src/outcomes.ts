import { isFields, type Fields } from "@novadeck/harness-core/fields"
import {
  addedFile,
  hunkChange,
  outcome,
  textChange,
  type Hunk,
} from "@novadeck/harness-core/outcomes"
import type { ToolChange, ToolOutcome } from "@novadeck/protocol"

// The code a failed command's result opens with, which Claude Code writes itself. A command
// that passed, or that its own rules take as no failure (a grep that found nothing), says none.
const exitLine = /^Exit code (-?\d+)(?:\n|$)/

const isHunk = (value: unknown): value is Hunk =>
  isFields(value) &&
  Number.isInteger(value.oldStart) &&
  Number.isInteger(value.newStart) &&
  Array.isArray(value.lines) &&
  value.lines.every((line) => typeof line === "string")

// The lines an Edit or a Write changed: the patch Claude Code records, with their numbers;
// a new file's whole text, for which it records none; or, with no patch, what an Edit replaced.
const changeOf = (detail: Fields): ToolChange | null => {
  const { structuredPatch: patch, type, content, oldString, newString } = detail
  if (type === "create" && typeof content === "string") return addedFile(content)
  if (Array.isArray(patch) && patch.length > 0 && patch.every(isHunk)) return hunkChange(patch)
  return typeof oldString === "string" && typeof newString === "string"
    ? textChange(oldString, newString)
    : null
}

// The lines a Read gave: what it counts, less the empty line it counts after a final break.
const linesRead = (detail: Fields): ToolOutcome["size"] => {
  const file = detail.file
  if (!isFields(file) || detail.type !== "text") return null
  const { numLines: count, content } = file
  if (!Number.isInteger(count) || typeof content !== "string") return null
  const lines = count as number
  return { count: Math.max(0, content.endsWith("\n") ? lines - 1 : lines), unit: "line" }
}

/**
 * What a tool's result says of its call: its error mark, and the detail Claude Code keeps beside
 * it (`toolUseResult`, an object for a tool that worked and the error's text for one that
 * didn't). A command it moved to the background has no end yet.
 */
export const outcomeOf = (failed: boolean, output: string, detail: unknown): ToolOutcome => {
  const fields = isFields(detail) ? detail : {}
  if (typeof fields.backgroundTaskId === "string") return outcome({ running: true })
  const code = failed ? exitLine.exec(output)?.[1] : undefined
  return outcome({
    failed,
    exit: code === undefined ? null : Number(code),
    size: linesRead(fields),
    change: failed ? null : changeOf(fields),
  })
}
