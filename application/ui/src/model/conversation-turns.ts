import type { ChatItem } from "./conversation"
import type { AgentStatus } from "./types"

// A conversation's items as a chat shows them: the person's messages, the agent's text,
// other agents' messages, and runs of tool calls, each call with the result its harness
// paired with it. Pure: the chat view renders what this returns.

// What a tool call came back with; null while it runs.
export type ToolResult = {
  readonly id: string
  readonly text: string
  readonly truncated: boolean
}

// One tool call. `tool` is null for a result whose call isn't among the items (a call
// left out of the window the backend carries), which still shows, as "Result".
export type ToolEntry = {
  readonly id: string
  readonly call: string | null
  readonly tool: string | null
  readonly input: string
  readonly truncated: boolean
  readonly result: ToolResult | null
}

export type ChatBlock =
  | {
      readonly kind: "user" | "assistant"
      readonly id: string
      readonly text: string
      readonly truncated: boolean
      readonly at: number | null
    }
  | {
      // Another agent's message, `author` in its harness's words.
      readonly kind: "agent"
      readonly id: string
      readonly author: string
      readonly text: string
      readonly truncated: boolean
      readonly at: number | null
    }
  // What the harness records of the person stopping the agent, and the like: a line, not a
  // message.
  | { readonly kind: "note"; readonly id: string; readonly text: string }
  // Consecutive tool calls, which the chat folds into one run.
  | {
      readonly kind: "tools"
      readonly id: string
      readonly entries: readonly ToolEntry[]
    }

// Claude Code records a stopped turn as a user message in brackets.
const interruption = /^\s*\[Request interrupted by user[^\]]*\]\s*$/

const asResult = (item: ChatItem): ToolResult => ({
  id: item.id,
  text: item.text,
  truncated: item.truncated,
})

// The items grouped in order. A result is paired by `call` with its call wherever it is
// (it may come first); one with no `call` goes to the latest call still waiting. A result
// whose call is not among the items stands alone.
export const groupItems = (items: readonly ChatItem[]): readonly ChatBlock[] => {
  const calls = new Set<string>()
  const results = new Map<string, ChatItem>()
  for (const item of items) {
    if (item.kind === "tool-call" && item.call) calls.add(item.call)
    if (item.kind === "tool-result" && item.call && !results.has(item.call))
      results.set(item.call, item)
  }
  const blocks: ChatBlock[] = []
  // The run of tool calls the latest items continue, if they do.
  const open: { run: ToolEntry[] | null } = { run: null }
  const entryBlock = (entry: ToolEntry): void => {
    if (open.run) open.run.push(entry)
    else {
      open.run = [entry]
      blocks.push({ kind: "tools", id: entry.id, entries: open.run })
    }
  }
  for (const item of items) {
    if (item.kind === "tool-call") {
      const result = item.call ? results.get(item.call) : undefined
      entryBlock({
        id: item.id,
        call: item.call,
        tool: item.tool ?? "tool",
        input: item.text,
        truncated: item.truncated,
        result: result ? asResult(result) : null,
      })
      continue
    }
    if (item.kind === "tool-result") {
      // Paired with a call among the items: shown with it.
      if (item.call && calls.has(item.call)) continue
      const last = open.run?.at(-1)
      if (!item.call && open.run && last && !last.result && !last.call) {
        open.run[open.run.length - 1] = { ...last, result: asResult(item) }
        continue
      }
      entryBlock({
        id: item.id,
        call: item.call,
        tool: null,
        input: "",
        truncated: false,
        result: asResult(item),
      })
      continue
    }
    open.run = null
    if (item.role === "user") {
      blocks.push(
        interruption.test(item.text)
          ? { kind: "note", id: item.id, text: "Interrupted" }
          : {
              kind: "user",
              id: item.id,
              text: item.text,
              truncated: item.truncated,
              at: item.at,
            },
      )
    } else if (item.role === "agent")
      blocks.push({
        kind: "agent",
        id: item.id,
        author: item.author ?? "Another agent",
        text: item.text,
        truncated: item.truncated,
        at: item.at,
      })
    else
      blocks.push({
        kind: "assistant",
        id: item.id,
        text: item.text,
        truncated: item.truncated,
        at: item.at,
      })
  }
  return blocks
}

const sameEntry = (a: ToolEntry, b: ToolEntry): boolean =>
  a.id === b.id &&
  a.tool === b.tool &&
  a.input === b.input &&
  a.truncated === b.truncated &&
  a.result?.id === b.result?.id &&
  a.result?.text === b.result?.text &&
  a.result?.truncated === b.result?.truncated

// Whether two groupings made the same block, so a view can keep what it drew: grouping
// builds new objects each time, though the items under most of them are the same.
export const sameBlock = (a: ChatBlock, b: ChatBlock): boolean => {
  if (a === b) return true
  if (a.kind === "tools" || b.kind === "tools")
    return (
      a.kind === "tools" &&
      b.kind === "tools" &&
      a.id === b.id &&
      a.entries.length === b.entries.length &&
      a.entries.every((entry, index) => sameEntry(entry, b.entries[index]!))
    )
  if (a.kind === "note" || b.kind === "note")
    return a.kind === "note" && b.kind === "note" && a.id === b.id && a.text === b.text
  return (
    a.kind === b.kind &&
    a.id === b.id &&
    a.text === b.text &&
    a.truncated === b.truncated &&
    (a.kind === "agent" ? a.author === (b as typeof a).author : true)
  )
}

// ---- Tool calls, in one line.

export type ToolKind = "run" | "read" | "write" | "search" | "web" | "agent" | "plan" | "other"

export type ToolSummary = {
  readonly kind: ToolKind
  // What the tool is called to a person: "Ran", "Read", "Edited".
  readonly title: string
  // What it was called on: the command, the file, the pattern. Empty where there is none.
  readonly detail: string
}

type Fields = Readonly<Record<string, unknown>>

// A string value, with the JSON quoting Antigravity wraps its arguments' strings in
// undone.
const unquote = (value: string): string => {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === "string" ? parsed : value
  } catch {
    return value
  }
}

const parseFields = (input: string): Fields | null => {
  try {
    const value: unknown = JSON.parse(input)
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Fields)
      : null
  } catch {
    return null
  }
}

// The first of `keys` the input holds as text.
const textField = (fields: Fields | null, ...keys: string[]): string => {
  if (!fields) return ""
  for (const key of keys) {
    const value = fields[key]
    if (typeof value === "string" && value.trim()) return unquote(value).trim()
  }
  return ""
}

const oneLine = (text: string): string => text.trim().split("\n", 1)[0]!.trim()

// A path's last segments, as long as it is.
export const shortPath = (path: string): string => {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path
}

// Codex's shell tools take the command as a list, often wrapped as `bash -lc <script>`.
const commandOf = (fields: Fields | null): string => {
  const text = textField(fields, "cmd", "command", "CommandLine")
  if (text) return text
  const list = fields?.command
  if (!Array.isArray(list)) return ""
  const words = list.filter((word): word is string => typeof word === "string")
  const wrapped = words.length === 3 && /^-\w*c$/.test(words[1]!)
  return oneLine(wrapped ? words[2]! : words.join(" "))
}

// The files a patch touches, from its `*** Add File: path` lines.
export const patchFiles = (patch: string): readonly string[] => [
  ...new Set(
    [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/gm)].map(
      (match) => match[1]!,
    ),
  ),
]

const fileList = (files: readonly string[]): string =>
  files.length <= 2
    ? files.map(shortPath).join(", ")
    : `${files.slice(0, 2).map(shortPath).join(", ")} +${files.length - 2}`

const count = (value: unknown, one: string, many = `${one}s`): string =>
  Array.isArray(value) ? `${value.length} ${value.length === 1 ? one : many}` : ""

// A tool call's one-line summary, from its name and its input as the harness wrote it
// (JSON, or raw text for a patch). Tools it doesn't know show their name and the first
// thing their input says.
export const toolSummary = (tool: string, input: string): ToolSummary => {
  const fields = parseFields(input)
  const mcp = mcpCall(tool, fields)
  const mcpKnown = mcp && mcpSummary(mcp)
  if (mcpKnown) return mcpKnown
  const known = knownTool(tool.toLowerCase(), fields, input)
  if (known) return known
  const detail =
    textField(
      fields,
      "command",
      "cmd",
      "file_path",
      "path",
      "url",
      "query",
      "pattern",
      "description",
      "toolSummary",
    ) || (fields ? "" : oneLine(input))
  return {
    kind: "other",
    title: tool,
    detail: detail ? shortenIf(detail) : "",
  }
}

// An MCP tool call, with the server it went to where the name says it.
type McpCall = {
  // Antigravity's lazy call, which hides the server and the tool in its arguments.
  readonly lazy: boolean
  readonly server: string
  readonly tool: string
  readonly fields: Fields | null
}

// Antigravity encodes a lazily loaded MCP tool as `call_mcp_tool` with the server, the
// tool and its arguments (an object, or JSON text) as arguments of its own.
const lazyMcp = "call_mcp_tool"

// The server and tool a name says, as each harness spells it: Claude Code's
// `mcp__plugin_novadeck_novadeck__send`, Codex's `mcp__novadeck__send` (its rollout
// gives the namespace `mcp__novadeck` and the tool `send` apart) or `mcp__novadeck.send`,
// and Antigravity's eagerly loaded `mcp_novadeck_novadeck_send`.
const mcpCall = (tool: string, fields: Fields | null): McpCall | undefined => {
  if (tool === lazyMcp) {
    const server = textField(fields, "ServerName")
    const name = textField(fields, "ToolName")
    if (!server || !name) return undefined
    const args = fields?.Arguments
    return {
      lazy: true,
      server,
      tool: name,
      fields: typeof args === "string" ? parseFields(unquote(args)) : isFields(args) ? args : null,
    }
  }
  const named =
    /^mcp__(.+?)__(.+)$/.exec(tool) ??
    /^mcp__([^.]+)\.(.+)$/.exec(tool) ??
    /^mcp_(novadeck_novadeck)_(.+)$/.exec(tool)
  return named ? { lazy: false, server: named[1]!, tool: named[2]!, fields } : undefined
}

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// The names Novadeck's server goes by: Claude Code's plugin, Codex's namespace and
// Antigravity's (lazy `ServerName` and eager prefix alike).
const novadeckServers: ReadonlySet<string> = new Set([
  "plugin_novadeck_novadeck",
  "novadeck",
  "novadeck_novadeck",
])

const isNovadeck = (server: string): boolean => novadeckServers.has(server)

const mcpSummary = ({ lazy, server, tool, fields }: McpCall): ToolSummary | undefined => {
  const known = isNovadeck(server) ? novadeckTool(tool, fields) : undefined
  // Another server's lazy tool shows its name and server; an eager one's name says both.
  return known ?? (lazy ? { kind: "other", title: tool, detail: server } : undefined)
}

// Novadeck's own MCP tools: the agent works with the person's other terminals.
const novadeckTool = (tool: string, fields: Fields | null): ToolSummary | undefined => {
  const text = (...keys: string[]): string => oneLine(textField(fields, ...keys))
  switch (tool) {
    case "send":
      return {
        kind: "agent",
        title: `Messaged${text("to") ? ` ${text("to")}` : ""}`,
        detail: text("text"),
      }
    case "agents":
      return { kind: "agent", title: "Listed agents", detail: "" }
    case "open_terminal": {
      const agent = text("agent")
      const task = text("message")
      return {
        kind: "agent",
        title: "Opened a terminal",
        detail: agent ? (task ? `${agent}: ${task}` : agent) : text("command", "title", "cwd"),
      }
    }
    case "close_terminal":
      return {
        kind: "agent",
        title: `Closed${text("to") ? ` ${text("to")}` : " a terminal"}`,
        detail: "",
      }
    case "show": {
      const url = text("url")
      return {
        kind: url ? "web" : "read",
        title: "Showed",
        detail: url || shortPath(text("path")),
      }
    }
    case "showing":
      return { kind: "read", title: "Checked what's shown", detail: "" }
    case "describe":
      return { kind: "agent", title: "Described this terminal", detail: text("title") }
    default:
      return undefined
  }
}

const shortenIf = (detail: string): string =>
  detail.startsWith("/") || /^[A-Za-z]:[\\/]/.test(detail) ? shortPath(detail) : oneLine(detail)

const knownTool = (name: string, fields: Fields | null, input: string): ToolSummary | undefined => {
  const path = (...keys: string[]): string => shortPath(textField(fields, ...keys))
  switch (name) {
    // Claude Code
    case "bash":
    // Codex
    case "exec_command":
    case "shell":
    case "shell_command":
    case "local_shell":
    case "container.exec":
    // Antigravity
    case "run_command":
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
    case "read":
    case "view_file":
    case "view_image":
    case "read_file":
      return {
        kind: "read",
        title: "Read",
        detail: path("file_path", "AbsolutePath", "path", "notebook_path"),
      }
    case "list_dir":
    case "ls":
      return {
        kind: "read",
        title: "Listed",
        detail: path("DirectoryPath", "path"),
      }
    case "write":
    case "write_to_file":
      return {
        kind: "write",
        title: "Wrote",
        detail: path("file_path", "TargetFile"),
      }
    case "edit":
    case "multiedit":
    case "notebookedit":
    case "replace_file_content":
    case "multi_replace_file_content":
      return {
        kind: "write",
        title: "Edited",
        detail: path("file_path", "TargetFile", "notebook_path"),
      }
    case "apply_patch": {
      // Raw patch text, or a JSON wrapper around it.
      const patch = textField(fields, "input", "patch") || input
      const files = patchFiles(patch)
      return { kind: "write", title: "Patched", detail: fileList(files) }
    }
    case "grep":
    case "grep_search":
      return {
        kind: "search",
        title: "Searched",
        detail: oneLine(textField(fields, "pattern", "Query", "query")),
      }
    case "glob":
    case "find_by_name":
      return {
        kind: "search",
        title: "Found files",
        detail: oneLine(textField(fields, "pattern", "Pattern")),
      }
    case "webfetch":
    case "read_url_content":
      return {
        kind: "web",
        title: "Fetched",
        detail: textField(fields, "url", "Url"),
      }
    case "websearch":
    case "search_web":
      return {
        kind: "web",
        title: "Searched the web",
        detail: textField(fields, "query"),
      }
    case "task":
    case "agent":
      return {
        kind: "agent",
        title: "Subagent",
        detail: oneLine(textField(fields, "description", "subagent_type", "prompt")),
      }
    case "todowrite":
      return {
        kind: "plan",
        title: "Updated todos",
        detail: count(fields?.todos, "item"),
      }
    case "update_plan":
      return {
        kind: "plan",
        title: "Updated plan",
        detail: count(fields?.plan, "step"),
      }
    case "exitplanmode":
      return { kind: "plan", title: "Proposed a plan", detail: "" }
    case "askuserquestion": {
      const first = Array.isArray(fields?.questions) ? (fields!.questions[0] as Fields) : null
      return {
        kind: "plan",
        title: "Asked",
        detail: oneLine(textField(first, "question")),
      }
    }
    default:
      return undefined
  }
}

// A tool call's input as a person reads it when the row opens: the one value a call holds,
// as it is; several, one `name: value` to a line, strings without their JSON quotes.
// Input that isn't JSON, such as a patch, is shown as written.
export const inputText = (input: string): string => {
  const fields = parseFields(input)
  if (!fields) return input
  const entries = Object.entries(fields).map(
    ([name, value]) =>
      [name, typeof value === "string" ? unquote(value) : JSON.stringify(value)] as const,
  )
  if (entries.length === 1) return entries[0]![1]
  return entries
    .map(([name, value]) => (value.includes("\n") ? `${name}:\n${value}` : `${name}: ${value}`))
    .join("\n")
}

// ---- What the agent is doing, in a line.

export type TurnStatus = {
  // The agent works: the chat shows its indicator.
  readonly working: boolean
  readonly text: string
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`

// What the chat says of the agent's turn: working (planning, with the subagents or
// background work it started running), or, once it rests, how its last turn ended where
// that wasn't a plain finish. Null when there is nothing to add.
export const turnStatus = (agent: AgentStatus | undefined): TurnStatus | null => {
  if (!agent) return null
  if (agent.working) {
    const parts = [agent.planning ? "Planning" : "Working"]
    const subagents = agent.subagents?.length ?? agent.background?.agents ?? 0
    if (subagents > 0) parts.push(`${plural(subagents, "subagent")} running`)
    const tasks = agent.background?.tasks ?? 0
    if (tasks > 0) parts.push(`${plural(tasks, "background task")}`)
    return { working: true, text: parts.join(" · ") }
  }
  switch (agent.lastTurn?.outcome) {
    case "interrupted":
      return { working: false, text: "Stopped before it finished" }
    case "failed":
      return { working: false, text: "Stopped with an error" }
    default:
      return null
  }
}

// An agent as its harness names it, as a person does.
export const agentName = (agent: string | null): string => {
  switch (agent) {
    case "claude":
      return "Claude"
    case "codex":
      return "Codex"
    case "agy":
      return "Antigravity"
    default:
      return "The agent"
  }
}
