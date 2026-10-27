import type { ToolRun } from "@novadeck/protocol"

export type { ToolRun }

/**
 * What a tool call was, in one line, from its name and its input as the harness wrote it
 * (JSON, or raw text for a patch). Each harness's `describe` names its own tools; what they
 * share is here: the field helpers, the line for a tool nobody knows, a shell command the
 * decoder makes up, and Novadeck's own MCP tools, which every harness reaches under its own
 * spelling of the server.
 */

export type Fields = Readonly<Record<string, unknown>>

export const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A string value, with the JSON quoting Antigravity wraps its arguments' strings in undone. */
export const unquote = (value: string): string => {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === "string" ? parsed : value
  } catch {
    return value
  }
}

/** An input's fields, or null where it is not a JSON object. */
export const parseFields = (input: string): Fields | null => {
  try {
    const value: unknown = JSON.parse(input)
    return isFields(value) ? value : null
  } catch {
    return null
  }
}

/** An object argument, as given or as the JSON text Antigravity may wrap it in. */
const nested = (value: unknown): Fields | null => {
  if (typeof value === "string") {
    try {
      return nested(JSON.parse(value))
    } catch {
      return null
    }
  }
  return isFields(value) ? value : null
}

/** The first of `keys` the input holds as text. */
export const textField = (fields: Fields | null, ...keys: string[]): string => {
  if (!fields) return ""
  for (const key of keys) {
    const value = fields[key]
    if (typeof value === "string" && value.trim()) return unquote(value).trim()
  }
  return ""
}

export const oneLine = (text: string): string => text.trim().split("\n", 1)[0]!.trim()

/** A path's last segments, as long as it is. */
export const shortPath = (path: string): string => {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path
}

export const fileList = (files: readonly string[]): string =>
  files.length <= 2
    ? files.map(shortPath).join(", ")
    : `${files.slice(0, 2).map(shortPath).join(", ")} +${files.length - 2}`

export const count = (value: unknown, one: string, many = `${one}s`): string =>
  Array.isArray(value) ? `${value.length} ${value.length === 1 ? one : many}` : ""

const shortenIf = (detail: string): string =>
  detail.startsWith("/") || /^[A-Za-z]:[\\/]/.test(detail) ? shortPath(detail) : oneLine(detail)

/**
 * The run of a shell command a decoder makes up itself, for the command the person typed in
 * shell mode (`!`).
 */
const shellRun = (command: string): ToolRun => ({
  kind: "run",
  title: "Ran",
  detail: oneLine(textField({ command }, "command")),
})

/**
 * The same as a `describe`, for the call a decoder makes up for a `!` command, whose input is
 * `{"command": …}`: it reads the item's own input, cut as any item's is, so a command too long
 * for an item has no detail, as a long call's input never parses.
 */
export const shellCall = (_tool: string, input: string): ToolRun => {
  const command = parseFields(input)?.command
  return shellRun(typeof command === "string" ? command : "")
}

/**
 * A tool the harness doesn't know: its name and the first thing its input says, or, for
 * input that isn't JSON, its first line.
 */
export const otherRun = (tool: string, fields: Fields | null, input: string): ToolRun => {
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
  return { kind: "other", title: tool, detail: detail ? shortenIf(detail) : "" }
}

/** Novadeck's own MCP tools: the agent works with the person's other terminals. */
export const novadeckTool = (tool: string, fields: Fields | null): ToolRun | undefined => {
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
        title: `Closed${text("to") ? ` ${text("to")}` : " a terminal"}`,
        detail: "",
      }
    case "show":
    case "close": {
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
    case "done":
      return { kind: "agent", title: "Reported done", detail: text("subject") }
    case "summarize":
      return { kind: "agent", title: "Summarized this terminal", detail: text("summary") }
    default:
      return undefined
  }
}

const number = String.raw`\d+(?:\.\d+)?`
// One command that only waits: Unix `sleep` (numbers with an optional s, m, h or d, GNU's
// several summing), PowerShell's `Start-Sleep` (a number, or `-Seconds`/`-Milliseconds`),
// and cmd's `timeout /t N` with `/nobreak`. Unix `timeout 30 cmd` runs a command: no match.
const sleeping: readonly RegExp[] = [
  new RegExp(String.raw`^sleep(?:\s+${number}[smhd]?)+$`),
  new RegExp(
    String.raw`^start-sleep\s+(?:(?:-(?:s|seconds|m|milliseconds)\s*:?\s*)?${number}|-(?:s|seconds|m|milliseconds)\s*:\s*${number})$`,
    "i",
  ),
  new RegExp(String.raw`^timeout(?:\s+/nobreak)?\s+/t\s+\d+(?:\s+/nobreak)?$`, "i"),
]

/**
 * Whether a shell command only waits: sleeps alone, or joined by `;`, `&&` or newlines. A
 * wait that checks something (`sleep 60 && git status`), pipes, redirects or backgrounds is
 * work, as is any command this doesn't recognise whole.
 */
export const sleepOnly = (command: string): boolean => {
  const parts = command
    .split(/;|&&|\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 0 && parts.every((part) => sleeping.some((each) => each.test(part)))
}
