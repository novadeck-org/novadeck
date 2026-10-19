import type { ChatAnswer, ChatDialog, ChatItem, Conversations } from "@novadeck/core/conversation"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { activeSession } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createDemoEngine } from "./engine"
import { demoBackend, withConversations } from "./index"
import { demoSeed, demoTerminalId } from "./samples"
import { agentTranscripts, showcaseTranscripts, type DemoTranscript } from "./transcripts"
import { demoTurns, demoTurnMs } from "./turns"
import { visitorStory } from "./visitor/story"

// The demo writes the line of every tool call it scripts by hand (`run`), where a real
// agent's decoder would say it. This holds them to what the chat's old `toolSummary` said of
// the same call, the function core had before the decoders took the vocabulary over: kept
// below as it was, and run on each scripted call's tool and input, which is what the chat
// read.

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
    case "show":
    case "close": {
      const url = text("url")
      const file = nested(fields?.file)
      const path = file ? oneLine(textField(file, "path")) : ""
      return {
        kind: url ? "web" : "read",
        title: tool === "show" ? "Showed" : "Closed",
        detail: url || shortPath(path),
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

// ---- The demo's calls.

const key = (slot: string, projectId = "storefront") => ({
  projectId,
  workspaceSessionId: "initial",
  terminalId: demoTerminalId({ projectId, workspaceSessionId: "initial" }, Number(slot)),
})

// Every tool call among a set of transcripts' items, and among what answering each request
// adds.
const scripted = (transcripts: Readonly<Record<string, DemoTranscript>>): ChatItem[] =>
  Object.values(transcripts).flatMap((transcript) => transcript.items)

const answers: readonly ChatAnswer[] = [
  { type: "choice", dialog: "d", option: "1" },
  { type: "choice", dialog: "d", option: "2" },
  { type: "choice", dialog: "d", option: "3" },
]
const dialog = { type: "choices", id: "d", title: null, detail: null, options: [] } as ChatDialog

const outcomeCalls = (
  transcripts: Readonly<Record<string, DemoTranscript>>,
): { call: string | null; tool: string | null; text: string; run: unknown }[] =>
  Object.values(transcripts).flatMap((transcript) =>
    Object.values(transcript.outcomes ?? {})
      .flatMap((outcome) =>
        answers.flatMap((answer) => {
          try {
            return outcome(answer, dialog).items.filter((item) => item.kind === "tool-call")
          } catch {
            return []
          }
        }),
      )
      .map((item) => ({
        call: item.call ?? null,
        tool: item.tool ?? null,
        text: item.text,
        run: item.run ?? null,
      })),
  )

describe("the demo's scripted tool calls", () => {
  const now = Date.now()

  it("show what the old table said of them", () => {
    const wrong: string[] = []
    let seen = 0
    const check = (call: {
      call: string | null
      tool: string | null
      text: string
      run: unknown
    }) => {
      seen += 1
      const old = toolSummary(call.tool ?? "tool", call.text)
      if (JSON.stringify(call.run) !== JSON.stringify(old))
        wrong.push(`${call.call}: ${JSON.stringify(call.run)} is not ${JSON.stringify(old)}`)
    }
    const stories = visitorStory(agentTranscripts(now), demoTurns(), 2000).transcripts
    for (const set of [agentTranscripts(now), showcaseTranscripts(now), stories]) {
      for (const item of scripted(set)) if (item.kind === "tool-call") check(item)
      for (const call of outcomeCalls(set)) check(call)
    }
    expect(wrong).toEqual([])
    // Not vacuous: the transcripts hold dozens of calls.
    expect(seen).toBeGreaterThan(30)
  })

  it("leave no call without one, and no other item with one", () => {
    for (const item of [...scripted(agentTranscripts(now)), ...scripted(showcaseTranscripts(now))])
      expect(item.run !== null, `${item.id}`).toBe(item.kind === "tool-call")
  })
})

describe("the tool calls the demo's agents make as they work", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const open = () => {
    const turns = demoTurns()
    const base = demoBackend(createDemoEngine())
    const backend = withConversations(
      { ...base, seed: demoSeed(Date.now(), true) },
      agentTranscripts(Date.now()),
      turns,
    )
    const store = createWorkspaceStore(
      workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 0 }),
      backend.commit,
    )
    backend.commit(store.getSnapshot(), [])
    backend.start!({ dispatch: (actions) => store.transact(actions as never), open: () => {} })
    const terminal = (slot: string) =>
      activeSession(store.getSnapshot())!.state.roster.terminals.find(
        (each) => each.id === key(slot).terminalId,
      )!
    return { chat: backend.conversations as Conversations, turns, terminal }
  }

  const callsOf = (chat: Conversations, slot: string) =>
    chat
      .conversation(key(slot))
      .getSnapshot()
      .items.filter((item) => item.kind === "tool-call")

  it("show what the old table said of each harness's tool, and of a shell command", async () => {
    const { chat, turns, terminal } = open()
    // Codex waits on the person and Antigravity reports nothing, so each is put at rest, and
    // then takes a prompt like Claude Code.
    turns.rest(key("04"), terminal("04"))
    turns.rest(key("05"), terminal("05"))
    await vi.advanceTimersByTimeAsync(0)
    await Promise.all(["06", "05", "04"].map((slot) => chat.send(key(slot), "check")))
    await vi.advanceTimersByTimeAsync(demoTurnMs)
    await chat.send(key("06"), "!git status")
    await vi.advanceTimersByTimeAsync(demoTurnMs)
    await chat.send(key("06"), '!"ls"')
    await vi.advanceTimersByTimeAsync(demoTurnMs)
    // A command too long for an item is cut as the runner cuts it, and has no detail.
    await chat.send(key("06"), `!${"x".repeat(20_000)}`)
    await vi.advanceTimersByTimeAsync(demoTurnMs)
    const started = new Map<string, number>()
    const found: ChatItem[] = []
    for (const slot of ["06", "05", "04"]) {
      const calls = callsOf(chat, slot).filter(
        (item) => item.call?.startsWith("demo-call-") ?? false,
      )
      started.set(slot, calls.length)
      found.push(...calls)
    }
    // A turn's tool in each harness, and Claude Code's made-up Bash call.
    expect([...started.values()].every((calls) => calls > 0)).toBe(true)
    const shell = callsOf(chat, "06").filter((item) => item.call === null)
    expect(shell.map((item) => item.run?.detail)).toEqual(["git status", "ls", ""])
    expect(shell.map((item) => item.truncated)).toEqual([false, false, true])
    expect(shell[2]!.text).toHaveLength(16_384)
    for (const item of [...found, ...shell])
      expect(item.run).toEqual(toolSummary(item.tool ?? "tool", item.text))
  })
})
