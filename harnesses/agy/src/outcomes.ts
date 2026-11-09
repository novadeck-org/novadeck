import { fieldsOf } from "@novadeck/harness-core/fields"
import { addedFile, changeOf, exited, outcome, textChange } from "@novadeck/harness-core/outcomes"
import { unquote } from "@novadeck/harness-core/tools"
import type { ToolOutcome } from "@novadeck/protocol"

// The times each result step opens with, then what Antigravity itself says of the call, before
// anything a tool printed (probed 1.2 to 1.5.2).
const opening = String.raw`^Created At: [^\n]*\n(?:Completed At: [^\n]*\n)?`
const exitLine = new RegExp(String.raw`${opening}Command exited with code (-?\d{1,10})\.`)
const readLine = new RegExp(String.raw`${opening}Showing lines (\d{1,10})-(\d{1,10}) of \d+`)
const editLine = new RegExp(
  String.raw`${opening}Made \d+ replacements? in .+ starting at line \d+ \(\+(\d{1,10})/-(\d{1,10}) lines\)\.`,
)
// What invoke_subagent's result says: the subagent it started, which runs on in the
// background and tells the root once it goes idle (probed 2026-11-09, 1.5.2,
// fixtures/subagent-transcript.probe.json).
const launchLine = new RegExp(
  String.raw`${opening}Created the following subagent:\n\{[^}]*?"conversationId":\s*"([^"\n]+)"`,
)

/**
 * The conversation of the subagent a result step says it started: invoke_subagent's
 * result is only that launch, the subagent's report coming later as a message (see
 * `endedSubagents` in transcripts.ts).
 */
export const launchedSubagent = (content: string): string | undefined =>
  launchLine.exec(content)?.[1]

/**
 * What a result step says of its call: its `status` (`DONE`; `ERROR` or `INVALID`, with
 * `error`; `RUNNING` for a command gone to the background) and the line it opens with. A
 * command's step is `DONE` whatever its exit code, so its code decides; a subagent's launch
 * is `DONE` while the subagent still runs, so it is running.
 */
export const stepOutcome = (
  status: unknown,
  error: unknown,
  content: string,
): ToolOutcome | null => {
  if (status === "RUNNING") return outcome({ running: true })
  if (status === "ERROR" || status === "INVALID" || (typeof error === "string" && error))
    return outcome({ failed: true })
  if (status !== "DONE") return null
  if (launchLine.test(content)) return outcome({ running: true })
  const code = exitLine.exec(content)?.[1]
  if (code !== undefined) return exited(Number(code))
  const read = readLine.exec(content)
  const edit = editLine.exec(content)
  return outcome({
    failed: false,
    opening: read !== null || edit !== null,
    size: read ? { count: Math.max(0, Number(read[2]) - Number(read[1]) + 1), unit: "line" } : null,
    // The counts alone: the call's input has the lines.
    change: edit ? { ...changeOf([]), added: Number(edit[1]), removed: Number(edit[2]) } : null,
  })
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? unquote(value) : undefined

/**
 * The lines an edit or a write's input says it changes: an edit's `Target` and `Replacement`, a
 * new file's or an appended `Content` (`write_to_file`'s `CodeContent` before 1.4). An overwrite
 * says nothing of the lines it replaced, and Antigravity's step calls it `Created file.` all
 * the same, so it has none.
 */
export const callChange = (tool: unknown, args: unknown): ToolOutcome | null => {
  const fields = fieldsOf(args)
  if (!fields) return null
  if (tool === "edit_file") {
    const [before, after] = [text(fields.Target), text(fields.Replacement)]
    return before === undefined || after === undefined
      ? null
      : outcome({ change: textChange(before, after) })
  }
  if (tool !== "write_file" && tool !== "write_to_file") return null
  const content = text(fields.Content) ?? text(fields.CodeContent)
  if (content === undefined || fields.Overwrite === true) return null
  // What it appends lands past lines it doesn't name.
  return outcome({ change: fields.Append === true ? textChange("", content) : addedFile(content) })
}
