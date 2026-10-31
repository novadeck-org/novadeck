import { commandFolder } from "@novadeck/harness-core/decode"
import type { ToolKind } from "@novadeck/harness-core/events"
import { fieldsOf, parseFields, type Fields } from "@novadeck/harness-core/fields"
import {
  count,
  fileList,
  novadeckTool,
  oneLine,
  otherRun,
  shortPath,
  sleepOnly,
  textField,
} from "@novadeck/harness-core/tools"
import type { ToolRun } from "@novadeck/protocol"

// Novadeck's MCP tools as Codex names them: `mcp__novadeck__send` (its rollout gives the
// namespace `mcp__novadeck` and the tool `send` apart, which the decoder joins) or
// `mcp__novadeck.send`.
const novadeck = [/^mcp__novadeck__(.+)$/, /^mcp__novadeck\.(.+)$/]

/** Whether a tool is one of Novadeck's own MCP server, by the server in its name. */
const isNovadeckTool = (tool: string): boolean => novadeck.some((each) => each.test(tool))

/**
 * An MCP tool's name as Codex's hooks give it: each character of its server and tool
 * outside ASCII letters, digits and `_` as one `_` (`probe-srv` and `probe.srv` both
 * `probe_srv`, `tüch` and `t😀ch` both `t_ch`; probed 0.159.3). Two servers that come out
 * the same each gain a hash of Codex's own (`a_b_e0598e406614`): their names match nothing,
 * so their requests settle only as before, and their dialogs read as none.
 */
export const mcpTool = (server: string, tool: string): string =>
  `mcp__${mcpName(server)}__${mcpName(tool)}`

/** One part of an MCP tool's name as Codex's hooks give it (see `mcpTool`). */
export const mcpName = (name: string): string => name.replace(/\W/gu, "_")

// Codex's shell tools take the command as a list, often wrapped as `bash -lc <script>`.
// The script is kept whole here (`commandOf` shows its first line), as its newlines join sleeps.
const scriptOf = (fields: Fields | undefined): string => {
  const text = textField(fields, "cmd", "command", "CommandLine")
  if (text) return text
  const list = fields?.command
  if (!Array.isArray(list)) return ""
  const words = list.filter((word): word is string => typeof word === "string")
  const wrapped = words.length === 3 && /^-\w*c$/.test(words[1]!)
  return wrapped ? words[2]! : words.join(" ")
}

const commandOf = (fields: Fields | undefined): string => {
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

const known = (name: string, fields: Fields | undefined, input: string): ToolRun | undefined => {
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
    case "request_user_input":
    case "request_user_input_async": {
      // As Claude Code's AskUserQuestion shows: its first question, which the async tool
      // calls a `title`.
      const first = Array.isArray(fields?.questions) ? fieldsOf(fields.questions[0]) : undefined
      return {
        kind: "plan",
        title: "Asked",
        detail: oneLine(textField(first, "question", "title")),
      }
    }
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

/**
 * The folder a call ran in, for its shell tools alone: their own `workdir` where the call
 * gives one, else a leading `cd` in its script, else the turn's directory its hook ran in.
 */
export const folderOf = (tool: string, input: unknown, cwd: unknown): string | undefined => {
  if (!shells.has(tool.toLowerCase())) return undefined
  const fields = fieldsOf(input)
  return commandFolder(scriptOf(fields), cwd, fields?.workdir)
}

/** What a tool call counts as to the messaging loop guard: see `ToolKind`. */
export const kindOf = (tool: string, input: unknown): ToolKind => {
  if (isNovadeckTool(tool)) return "novadeck"
  const name = tool.toLowerCase()
  if (name === "update_plan") return "bookkeeping"
  if (shells.has(name)) {
    const fields = fieldsOf(input)
    return sleepOnly(scriptOf(fields)) ? "waiting" : "work"
  }
  return "work"
}
