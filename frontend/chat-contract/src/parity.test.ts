import { transcripts as agy } from "@novadeck/harness-agy/transcripts"
import { transcripts as claude } from "@novadeck/harness-claude/transcripts"
import { transcripts as codex } from "@novadeck/harness-codex/transcripts"

import type { Transcripts } from "./pipeline"
import { describe, expect, it } from "./test"

// Splitting the tool vocabulary by harness (each harness's `describe`) must not change a
// row. This runs a table of calls, today's tests' cases and sweeps of every tool name the old
// flat table knew, through each harness's real decoder, and compares the run each call
// gets with what the old `toolSummary` said of the same call: the flat function core had
// before the split, kept below as it was, run on the decoded item's tool (null as "tool")
// and text, which is what the chat read.
//
// A difference is allowed only where the harness's decoder never emits the name or spelling:
// `emits` and `spellings` say which each harness does. The test fails on any other difference,
// and on an allowance no case needs: a name or spelling a harness is said not to emit, where
// every case of it still reads the same.

// ---- The old function, as it was in core's conversation-turns.ts.

type ToolKind = "run" | "read" | "write" | "search" | "web" | "agent" | "plan" | "other"

type ToolSummary = {
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

// An object argument, as given or as the JSON text Antigravity may wrap it in.
const nested = (value: unknown): Fields | null => {
  if (typeof value === "string") {
    try {
      return nested(JSON.parse(value))
    } catch {
      return null
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : null
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
const shortPath = (path: string): string => {
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
const patchFiles = (patch: string): readonly string[] => [
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
const toolSummary = (tool: string, input: string): ToolSummary => {
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
    case "open_terminal":
      return {
        kind: "agent",
        title: "Opened a terminal",
        detail: text("command", "title", "cwd"),
      }
    case "open_agent": {
      const agent = text("agent")
      const task = text("message")
      return {
        kind: "agent",
        title: "Opened an agent",
        detail: agent ? (task ? `${agent}: ${task}` : agent) : task,
      }
    }
    case "close_terminal":
      return {
        kind: "agent",
        title: `Close${text("to") ? ` ${text("to")}` : " a terminal"}`,
        detail: "",
      }
    case "lead":
      return {
        kind: "agent",
        title: `Asked to lead${text("to") ? ` ${text("to")}` : " an agent"}`,
        detail: text("message"),
      }
    case "release":
      return {
        kind: "agent",
        title: `Released${text("to") ? ` ${text("to")}` : " an agent"}`,
        detail: "",
      }
    case "show":
    case "close": {
      // A page by its address under page, since show and close took pages so.
      const page = nested(fields?.page)
      const url = page ? oneLine(textField(page, "url")) : ""
      const file = nested(fields?.file)
      const path = file ? oneLine(textField(file, "path")) : ""
      const changes = nested(fields?.changes) !== null
      return {
        kind: url ? "web" : "read",
        title: tool === "show" ? "Showed" : "Closed",
        detail: url || (changes ? "the changes" : shortPath(path)),
      }
    }
    case "showing":
      return { kind: "read", title: "Checked what's shown", detail: "" }
    case "summarize":
      return { kind: "agent", title: "Summarized this terminal", detail: text("summary") }
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

// ---- The table.

type Harness = "claude" | "codex" | "agy"

const harnesses: Readonly<Record<Harness, Transcripts>> = { claude, codex, agy }

// Each harness's records for a tool call of this name and input (text).
const records: Readonly<
  Record<Harness, (tool: string | undefined, input: string) => readonly object[]>
> = {
  claude: (name, input) => [
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_1", name, input }] },
    },
  ],
  codex: (name, input) => [
    {
      type: "response_item",
      payload: { type: "custom_tool_call", name, input, call_id: "call_1" },
    },
  ],
  agy: (name, input) => [
    {
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      step_index: 1,
      tool_calls: [{ name, args: input }],
    },
  ],
}

// Codex writes a call as a function call (arguments as JSON text) or a custom tool call (raw
// input); a function call's arguments may be an object, and an MCP tool's server goes in a
// namespace of its own, which the decoder joins to the name.
type Variant = {
  readonly label: string
  readonly harness: Harness
  readonly records: (tool: string | undefined, input: string) => readonly object[] | null
}

const asObject = (input: string): object | null => {
  try {
    const value: unknown = JSON.parse(input)
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

const codexFunction = (name: string | undefined, input: string, namespace?: string) => ({
  type: "response_item",
  payload: { type: "function_call", name, namespace, arguments: input, call_id: "call_1" },
})

const variants: readonly Variant[] = [
  ...(["claude", "codex", "agy"] as const).map((harness) => ({
    label: harness,
    harness,
    records: records[harness],
  })),
  {
    label: "codex function_call",
    harness: "codex",
    records: (name, input) => [codexFunction(name, input)],
  },
  {
    label: "codex function_call, arguments as an object",
    harness: "codex",
    records: (name, input) => {
      const object = asObject(input)
      return object ? [codexFunction(name, object as unknown as string)] : null
    },
  },
  {
    label: "codex function_call, namespace joined",
    harness: "codex",
    records: (name, input) => {
      const joined = /^mcp__novadeck__(.+)$/.exec(name ?? "")
      return joined ? [codexFunction(joined[1], input, "mcp__novadeck")] : null
    },
  },
]

// The call a harness's decoder makes of a record, with the run it gave it.
const callOf = (
  harness: Harness,
  lines: readonly object[],
): { tool: string | null; text: string; run: unknown } => {
  const [call, ...rest] = lines.flatMap((line) =>
    harnesses[harness].items(JSON.stringify(line)).filter((each) => each.kind === "tool-call"),
  )
  if (!call || rest.length > 0) throw new Error(`${harness} made ${rest.length + 1} calls`)
  return { tool: call.tool, text: call.text, run: call.run }
}

// What the old function said of the call, as the chat read the decoded item.
const oldOf = (call: { tool: string | null; text: string }): ToolSummary =>
  toolSummary(call.tool ?? "tool", call.text)

// The names each harness has (lower case), the tool names the old table knew that its
// decoder can emit. A name outside the list may differ; one inside must not.
const emits: Readonly<Record<Harness, ReadonlySet<string>>> = {
  claude: new Set([
    "bash",
    "read",
    "ls",
    "write",
    "edit",
    "multiedit",
    "notebookedit",
    "grep",
    "glob",
    "webfetch",
    "websearch",
    "task",
    "agent",
    "todowrite",
    "exitplanmode",
    "askuserquestion",
  ]),
  codex: new Set([
    "exec_command",
    "shell",
    "shell_command",
    "local_shell",
    "container.exec",
    "exec",
    "write_stdin",
    "view_image",
    "read_file",
    "list_dir",
    "apply_patch",
    "update_plan",
  ]),
  agy: new Set([
    "run_command",
    "view_file",
    "read_file",
    "list_dir",
    "write_to_file",
    "replace_file_content",
    "multi_replace_file_content",
    "grep_search",
    "find_by_name",
    "read_url_content",
    "search_web",
  ]),
}

// The Novadeck MCP spellings: Claude Code's plugin, Codex's namespace (joined by its
// decoder, or written whole), and Antigravity's eager prefix and lazy call.
// `mcp__novadeck_novadeck__` is the old table's reading of the Antigravity server name in the
// generic form; no harness spells it so, so every harness may differ there.
const spellings: readonly [Harness | null, RegExp][] = [
  ["claude", /^mcp__plugin_novadeck_novadeck__/],
  [null, /^mcp__novadeck_novadeck__/],
  ["codex", /^mcp__novadeck__/],
  ["codex", /^mcp__novadeck\./],
  ["agy", /^mcp_novadeck_novadeck_/],
]

// Whether a harness's decoder can emit a call of this name.
const emitted = (harness: Harness, tool: string | undefined): boolean => {
  if (tool === undefined) return true
  const spelled = spellings.find(([, pattern]) => pattern.test(tool))
  if (spelled) return spelled[0] === harness
  if (tool === "call_mcp_tool") return harness === "agy"
  // Another server's MCP tool, or a tool nobody knows, is described the same by all.
  const known = Object.values(emits).some((names) => names.has(tool.toLowerCase()))
  return known ? emits[harness].has(tool.toLowerCase()) : true
}

const json = (value: unknown): string => JSON.stringify(value)
const patch = [
  "*** Begin Patch",
  "*** Update File: src/a.ts",
  "@@",
  "-x",
  "+y",
  "*** Add File: src/b.ts",
  "+z",
  "*** Delete File: old.ts",
  "*** Add File: c.ts",
  "*** End Patch",
].join("\n")

// Every tool name the old table knew, in the case the harnesses write it.
const known = [
  "Bash",
  "exec_command",
  "shell",
  "shell_command",
  "local_shell",
  "container.exec",
  "run_command",
  "exec",
  "write_stdin",
  "Read",
  "view_file",
  "view_image",
  "read_file",
  "list_dir",
  "LS",
  "Write",
  "write_to_file",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "replace_file_content",
  "multi_replace_file_content",
  "apply_patch",
  "Grep",
  "grep_search",
  "Glob",
  "find_by_name",
  "WebFetch",
  "read_url_content",
  "WebSearch",
  "search_web",
  "Task",
  "Agent",
  "TodoWrite",
  "update_plan",
  "ExitPlanMode",
  "AskUserQuestion",
  "mystery",
]

// The inputs a call may hold: those of today's tests, and one of every field the old table
// reads.
const inputs: readonly string[] = [
  "{}",
  "",
  "[1,2]",
  "first line\nsecond",
  patch,
  json({ input: patch }),
  json({ patch }),
  json({ command: "pnpm test\nmore", description: "Run" }),
  json({ cmd: "ls -la", workdir: "/x" }),
  json({ CommandLine: "ls", Cwd: json("/p") }),
  json({ CommandLine: json("git status --short") }),
  json({ chars: "y\n" }),
  json({ file_path: "/a/b/c/d/e.ts" }),
  json({ file_path: "src/x.ts" }),
  json({ notebook_path: "/a/b/c/d/n.ipynb" }),
  json({ AbsolutePath: "/p/c.txt" }),
  json({ path: "C:\\a\\b\\c\\d.txt" }),
  json({ DirectoryPath: "/a/b/c/d" }),
  json({ TargetFile: json("/home/user/project/README.md") }),
  json({ pattern: "foo", path: "src" }),
  json({ Pattern: "**/*.ts" }),
  json({ Query: "q", query: "x" }),
  json({ query: "select 1" }),
  json({ url: "https://example.com" }),
  json({ Url: "https://example.com/a" }),
  json({ description: "Explore the repo", subagent_type: "Explore", prompt: "p" }),
  json({ todos: [{}, {}, {}] }),
  json({ todos: [{}] }),
  json({ plan: [{}, {}] }),
  json({ questions: [{ question: "Which one?\nReally?" }] }),
  json({ toolSummary: "Touch file" }),
  json({ path: "/a/b/c/d/e.ts", toolSummary: "x" }),
]

// Codex's shell tools take the command as a list; Claude Code's and Antigravity's take text,
// so only Codex's names are given these.
const listInputs: readonly string[] = [
  json({ command: ["bash", "-lc", "git status"] }),
  json({ command: ["ls", "-la"] }),
  json({ command: ["bash", "-c", "a\nb"] }),
  json({ command: ["sh", "-c"] }),
  json({ command: [1, "x"] }),
]

type Row = {
  readonly label: string
  readonly tool: string | undefined
  readonly input: string
}

const rows: Row[] = []
const add = (tool: string | undefined, input: string): void => {
  rows.push({ label: `${tool ?? "(no tool)"} ← ${input.slice(0, 48)}`, tool, input })
}

for (const tool of known) for (const input of inputs) add(tool, input)
for (const tool of emits.codex) for (const input of listInputs) add(tool, input)
// Case is not part of a name.
for (const tool of ["BASH", "exec_Command", "VIEW_FILE", "Webfetch", "Mystery"])
  for (const input of inputs.slice(5, 10)) add(tool, input)

// Novadeck's MCP tools, in every spelling.
const novadeck = [
  "send",
  "agents",
  "open_terminal",
  "open_agent",
  "close_terminal",
  "lead",
  "release",
  "show",
  "close",
  "showing",
  "summarize",
  "new",
]
const novadeckInputs = [
  { to: "fox", text: "Tests are green.\nShip it." },
  { text: "no one" },
  {},
  { agent: "codex", message: "Fix the lint\nerrors" },
  { agent: "claude" },
  { command: "pnpm dev" },
  { title: "t", cwd: "/a/b/c/d" },
  { to: "owl" },
  { page: { url: "http://localhost:5173/" } },
  { page: '{"url":"http://localhost:5173/"}' },
  { url: "http://localhost:5173/" },
  { file: { path: "/a/b/c/d/mock.png" } },
  { file: '{"path":"/a/b/c/d/mock.png"}' },
  { changes: {} },
  { changes: "{}" },
  { summary: "Fixing the cart rounding" },
]
for (const tool of novadeck)
  for (const given of novadeckInputs) {
    for (const prefix of [
      "mcp__plugin_novadeck_novadeck__",
      "mcp__novadeck__",
      "mcp__novadeck.",
      "mcp_novadeck_novadeck_",
      "mcp__novadeck_novadeck__",
      "MCP__NOVADECK__",
    ])
      add(`${prefix}${tool}`, json({ ...given, toolSummary: "send call" }))
    for (const server of ["novadeck_novadeck", "novadeck", "db", "my_novadeck"])
      for (const wrap of [(a: object) => a, json, (a: object) => json(json(a))])
        add(
          "call_mcp_tool",
          json({
            ServerName: server,
            ToolName: tool,
            toolAction: "Calling",
            Arguments: wrap(given),
          }),
        )
  }
// Other servers' tools, and a Novadeck tool named like one but not it.
for (const tool of [
  "mcp__db__query",
  "mcp__db__send",
  "mcp__plugin_acme_novadeck__send",
  "mcp__my_novadeck__send",
  "mcp__novadeck_extra__send",
  "mcp_github_create_issue",
  "mcp__github__create_issue",
  "mcp__novadeck",
  "call_mcp_tool",
])
  for (const input of [
    json({ to: "fox" }),
    json({ query: "select 1" }),
    json({ ServerName: "github", ToolName: "create_issue", Arguments: { title: "t" } }),
    json({ ServerName: "github" }),
    json({ ToolName: "create_issue" }),
    "{}",
    "raw",
  ])
    add(tool, input)

// The edges of what a record holds: a tool with no name, a long one, and input cut at 16 KiB.
for (const input of inputs.slice(0, 12)) add(undefined, input)
add("t".repeat(300), json({ command: "ls" }))
add("Bash".padEnd(300, "x"), json({ command: "ls" }))
add("mcp__novadeck__".padEnd(300, "x"), "{}")
const big = "x".repeat(20_000)
add("Bash", json({ command: big }))
add("exec_command", json({ cmd: big }))
add("run_command", json({ CommandLine: big }))
add("apply_patch", `${patch}\n${big}`)
add("apply_patch", json({ input: `${patch}\n${big}` }))
add("exec", big)
add("mystery", big)
add("mystery", json({ command: big }))
add("Write", json({ file_path: `/${"a/".repeat(6000)}x.ts` }))
add("mcp__novadeck__send", json({ to: "fox", text: big }))

describe("the tool vocabulary split by harness", () => {
  for (const harness of ["claude", "codex", "agy"] as const) {
    const mine = variants.filter((variant) => variant.harness === harness)
    describe(harness, () => {
      it("describes every call as the old flat table did, except names its decoder never emits", () => {
        const wrong: string[] = []
        // The tools that differ from the old table's reading, by name.
        const differed = new Set<string>()
        let compared = 0
        for (const variant of mine)
          for (const { label, tool, input } of rows) {
            const lines = variant.records(tool, input)
            if (!lines) continue
            compared += 1
            const call = callOf(harness, lines)
            if (JSON.stringify(call.run) === JSON.stringify(oldOf(call))) continue
            differed.add(tool ?? "")
            // The decoder cuts the name; the cut name is what the old chat read.
            if (emitted(harness, tool) && emitted(harness, call.tool ?? "tool"))
              wrong.push(`${variant.label}: ${label}`)
          }
        expect(wrong).toEqual([])
        expect(compared).toBeGreaterThanOrEqual(rows.length)
        // No allowance without a case that needs it: each name or spelling this harness is said
        // not to emit differs somewhere.
        const names = [...differed].map((name) => name.toLowerCase())
        const unneeded = [...Object.values(emits).flatMap((all) => [...all]), "call_mcp_tool"]
          .filter(
            (name) => !emits[harness].has(name) && !(name === "call_mcp_tool" && harness === "agy"),
          )
          .filter((name) => !names.includes(name))
        const unusedSpellings = spellings
          .filter(([owner]) => owner !== harness)
          .filter(
            ([, pattern]) => !names.some((name) => pattern.test(name.replace(/^mcp__/i, "mcp__"))),
          )
        expect([...new Set(unneeded)]).toEqual([])
        expect(unusedSpellings.map(([, pattern]) => String(pattern))).toEqual([])
      })

      it("describes each name it emits by its own table, never by the fallback for a tool it doesn't know", () => {
        // Every name it emits is described by its own table, never by the fallback.
        for (const name of emits[harness])
          for (const variant of mine) {
            const lines = variant.records(name, "{}")
            if (!lines) continue
            const call = callOf(harness, lines)
            expect(call.run).toMatchObject({ kind: expect.not.stringMatching(/^other$/) })
          }
      })
    })
  }
})

describe("a command typed in shell mode", () => {
  const commands = [
    "ls -la",
    "echo first\necho second",
    "  padded  ",
    '"quoted"',
    "x".repeat(20_000),
    "",
  ]

  it("reads as the old table read Bash, in Claude Code's and Codex's decoders", () => {
    for (const command of commands.filter(Boolean)) {
      const lines = {
        claude: [
          { type: "user", uuid: "u1", message: { content: `<bash-input>${command}</bash-input>` } },
        ],
        codex: [
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              id: "m1",
              content: [
                {
                  type: "input_text",
                  text: `<user_shell_command>\n<command>\n${command}\n</command>\n<result>\nExit code: 0\nDuration: 0.1 seconds\nOutput:\nok\n</result>\n</user_shell_command>`,
                },
              ],
            },
          },
        ],
      }
      for (const harness of ["claude", "codex"] as const) {
        const call = callOf(harness, lines[harness])
        expect(call.tool).toBe("Bash")
        expect({ harness, command: command.slice(0, 20), run: call.run }).toEqual({
          harness,
          command: command.slice(0, 20),
          run: oldOf(call),
        })
      }
    }
  })
})
