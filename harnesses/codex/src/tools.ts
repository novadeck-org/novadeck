import type { ToolKind } from "@novadeck/harness-core/events"
import {
  count,
  fileList,
  isFields,
  novadeckTool,
  oneLine,
  otherRun,
  parseFields,
  shortPath,
  sleepOnly,
  textField,
  type Fields,
  type ToolRun,
} from "@novadeck/harness-core/tools"

// Novadeck's MCP tools as Codex names them: `mcp__novadeck__send` (its rollout gives the
// namespace `mcp__novadeck` and the tool `send` apart, which the decoder joins) or
// `mcp__novadeck.send`.
const novadeck = [/^mcp__novadeck__(.+)$/, /^mcp__novadeck\.(.+)$/]

/** Whether a tool is one of Novadeck's own MCP server, by the server in its name. */
export const isNovadeckTool = (tool: string): boolean => novadeck.some((each) => each.test(tool))

// Codex's shell tools take the command as a list, often wrapped as `bash -lc <script>`.
// The script is kept whole here (`commandOf` shows its first line), as its newlines join sleeps.
export const scriptOf = (fields: Fields | null): string => {
  const text = textField(fields, "cmd", "command", "CommandLine")
  if (text) return text
  const list = fields?.command
  if (!Array.isArray(list)) return ""
  const words = list.filter((word): word is string => typeof word === "string")
  const wrapped = words.length === 3 && /^-\w*c$/.test(words[1]!)
  return wrapped ? words[2]! : words.join(" ")
}

const commandOf = (fields: Fields | null): string => {
  const text = textField(fields, "cmd", "command", "CommandLine")
  return text || oneLine(scriptOf(fields))
}

// The files a patch touches, from its `*** Add File: path` lines.
const patchFiles = (patch: string): readonly string[] => [
  ...new Set(
    [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/gm)].map(
      (match) => match[1]!,
    ),
  ),
]

const known = (name: string, fields: Fields | null, input: string): ToolRun | undefined => {
  const path = (...keys: string[]): string => shortPath(textField(fields, ...keys))
  switch (name) {
    case "exec_command":
    case "shell":
    case "shell_command":
    case "local_shell":
    case "container.exec":
      return { kind: "run", title: "Ran", detail: oneLine(commandOf(fields)) }
    case "exec":
      // Codex's code tool takes its program as raw text.
      return {
        kind: "run",
        title: "Ran",
        detail: fields ? oneLine(commandOf(fields)) : oneLine(input),
      }
    case "write_stdin":
      return {
        kind: "run",
        title: "Sent input",
        detail: oneLine(textField(fields, "chars")),
      }
    case "view_image":
    case "read_file":
      return {
        kind: "read",
        title: "Read",
        detail: path("file_path", "AbsolutePath", "path", "notebook_path"),
      }
    case "list_dir":
      return { kind: "read", title: "Listed", detail: path("DirectoryPath", "path") }
    case "apply_patch": {
      // Raw patch text, or a JSON wrapper around it.
      const patch = textField(fields, "input", "patch") || input
      return { kind: "write", title: "Patched", detail: fileList(patchFiles(patch)) }
    }
    case "update_plan":
      return { kind: "plan", title: "Updated plan", detail: count(fields?.plan, "step") }
    default:
      return undefined
  }
}

/**
 * What a Codex tool call was, from its name and its input as text (JSON, or the raw patch
 * of `apply_patch`). Names match without regard to case; one it doesn't know shows its
 * name and the first thing its input says.
 */
export const describe = (tool: string, input: string): ToolRun => {
  const fields = parseFields(input)
  const mcp = novadeck.map((each) => each.exec(tool)?.[1]).find((each) => each !== undefined)
  return (
    (mcp === undefined ? undefined : novadeckTool(mcp, fields)) ??
    known(tool.toLowerCase(), fields, input) ??
    otherRun(tool, fields, input)
  )
}

// Codex's shell tools, by the names its hooks give them.
const shells: ReadonlySet<string> = new Set([
  "bash",
  "shell",
  "shell_command",
  "exec_command",
  "local_shell",
  "container.exec",
])

/** What a tool call counts as to the messaging loop guard: see `ToolKind`. */
export const kindOf = (tool: string, input: unknown): ToolKind => {
  if (isNovadeckTool(tool)) return "novadeck"
  const name = tool.toLowerCase()
  if (name === "update_plan") return "bookkeeping"
  if (shells.has(name)) {
    const fields = isFields(input) ? input : null
    return sleepOnly(scriptOf(fields)) ? "waiting" : "work"
  }
  return "work"
}
