import { fileURLToPath } from "node:url"

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
  // The script a shell is handed: bash's `-lc`, PowerShell's `-Command` (after any
  // `-NoProfile`), cmd's `/c`.
  const wrapped =
    words.length >= 3 &&
    /(?:^|[\\/])(?:(?:ba|da|k|z)?sh|pwsh|powershell|cmd)(?:\.exe)?$/i.test(words[0]!) &&
    /^(?:-\w*c|-command|\/c)$/i.test(words.at(-2)!)
  return wrapped ? words.at(-1)! : words.join(" ")
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
    // The subagent tools. Rollouts record them as function calls in the namespace
    // `collaboration` (seen 0.162 to 0.165: send_message {target, message}, wait_agent
    // {timeout_ms}, followup_task {target, message}, spawn_agent {task_name, agent_type,
    // message}, list_agents {}); the tool list offers them as `multi_agent_v1.x`, and a hook
    // names them `collaborationx`.
    case "spawn_agent":
      return {
        kind: "agent",
        title: "Subagent",
        detail: oneLine(textField(fields, "task_name", "agent_type", "message", "description")),
      }
    case "send_message":
    case "send_input": {
      const target = oneLine(textField(fields, "target", "id"))
      return {
        kind: "agent",
        title: target ? `Messaged ${target}` : "Messaged a subagent",
        detail: oneLine(textField(fields, "message", "input", "text")),
      }
    }
    case "followup_task": {
      const target = oneLine(textField(fields, "target", "id"))
      return {
        kind: "agent",
        title: target ? `Followed up with ${target}` : "Followed up with a subagent",
        detail: oneLine(textField(fields, "message")),
      }
    }
    case "list_agents":
      return { kind: "agent", title: "Listed subagents", detail: "" }
    case "wait_agent":
      return { kind: "agent", title: "Waited for a subagent", detail: "" }
    case "close_agent":
      return {
        kind: "agent",
        title: "Closed a subagent",
        detail: oneLine(textField(fields, "target", "id")),
      }
    case "resume_agent":
      return {
        kind: "agent",
        title: "Resumed a subagent",
        detail: oneLine(textField(fields, "target", "id")),
      }
    case "wait":
      // Code mode's wait on a running exec cell: {cell_id, yield_time_ms, max_tokens}.
      return { kind: "run", title: "Waited", detail: "" }
    // Rollouts give these as namespace and name apart (`clock__sleep`); the tool list
    // spells them `clock.sleep`. clock.sleep takes {duration_ms}.
    case "clock.curr_time":
      return { kind: "run", title: "Checked the time", detail: "" }
    case "clock.sleep":
      return { kind: "run", title: "Waited", detail: "" }
    case "mcp__codex_worktrees.create_worktree":
      return { kind: "run", title: "Created a worktree", detail: "" }
    case "mcp__codex_worktrees.get_worktree_creation_status":
      return { kind: "run", title: "Checked a worktree", detail: "" }
    case "mcp__codex_worktrees.list_worktrees":
      return { kind: "run", title: "Listed worktrees", detail: "" }
    case "list_mcp_resources":
    case "list_mcp_resource_templates":
      return { kind: "read", title: "Listed MCP resources", detail: "" }
    case "read_mcp_resource":
      return { kind: "read", title: "Read an MCP resource", detail: textField(fields, "uri") }
    case "request_permissions":
      // Asks the person to grant more access; its dialog is the Inbox's request.
      return {
        kind: "plan",
        title: "Asked for permissions",
        detail: oneLine(textField(fields, "reason")),
      }
    case "web_search": {
      // A search, or (as a `web_search_call` item) a page it opened or searched in.
      const query = textField(fields, "query")
      const url = textField(fields, "url")
      const pattern = textField(fields, "pattern")
      if (query || (!url && !pattern))
        return { kind: "web", title: "Searched the web", detail: query }
      if (!pattern) return { kind: "web", title: "Opened a page", detail: url }
      return {
        kind: "web",
        title: "Searched a page",
        detail: url ? `${pattern} in ${url}` : pattern,
      }
    }
    case "image_generation":
      return {
        kind: "other",
        title: "Generated an image",
        detail: oneLine(textField(fields, "prompt")),
      }
    case "create_goal":
    case "update_goal":
    case "get_goal":
      return {
        kind: "plan",
        title: {
          create_goal: "Set a goal",
          update_goal: "Updated the goal",
          get_goal: "Read the goal",
        }[name]!,
        detail: oneLine(textField(fields, "objective", "goal", "status")),
      }
    default:
      return undefined
  }
}

// A multi_agent tool by its own name, however Codex spells its namespace: `multi_agent_v1.x`,
// `multi_agent_v1__x`, or `collaborationx` in a hook.
const subagentTool = (name: string): string =>
  /^(?:multi_agent_v\d+|collaboration)(?:\.|__)?(spawn_agent|send_message|send_input|followup_task|list_agents|wait_agent|close_agent|resume_agent)$/.exec(
    name,
  )?.[1] ?? name

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
    known(
      subagentTool(tool.toLowerCase()).replace(/^(clock|mcp__codex_worktrees)__/, "$1."),
      fields,
      input,
    ) ??
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
 * The folder a command its rollout records ran in: a leading `cd` in its script, from the
 * command's own directory (`cwd`, its `workdir` or else the turn's), as a path or a
 * `file://` URL. Its hook names only the turn's directory, so this is what tells where it
 * works (see the rollout's `command-ran`).
 */
export const commandRanIn = (command: unknown, cwd: unknown): string | undefined => {
  const directory = typeof cwd === "string" && cwd.startsWith("file://") ? fromFileUrl(cwd) : cwd
  return commandFolder(scriptOf(fieldsOf({ command })), directory)
}

/**
 * A `file://` URL's path, or undefined for one that isn't a local file's: by Windows' rules
 * for a drive's (`file:///C:/w`) or a share's (`file://host/share`), else POSIX's, whatever
 * the runner runs on, as `commandFolder` reads paths.
 */
const fromFileUrl = (url: string): string | undefined => {
  try {
    return fileURLToPath(url, { windows: /^file:\/\/(?:\/[a-z]:|[^/])/i.test(url) })
  } catch {
    return undefined
  }
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
