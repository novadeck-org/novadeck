// Each harness's permission hook payload, read into the shell command it asks about.
import { maxCommand, type NotACall, type ShellCall } from "../grants.js"

type Harness = "claude" | "codex" | "agy"

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

// The harness's events that carry the call, and the tool-input fields it may have.
const events: Record<Harness, string> = {
  claude: "PreToolUse",
  codex: "PermissionRequest",
  agy: "PreToolUse",
}

const fields: Record<Harness, Record<string, "string" | "number">> = {
  claude: { command: "string", description: "string", timeout: "number" },
  codex: { command: "string", description: "string" },
  agy: { CommandLine: "string", WaitMsBeforeAsync: "number", toolSummary: "string" },
}

/**
 * The `run_command` and `Bash` calls' shell command, from the harness's raw payload, on
 * `platform` (the machine the harness runs on): Codex's there is marked as Windows'.
 */
export const callFromPayload = (
  harness: Harness,
  event: string,
  payload: unknown,
  platform: NodeJS.Platform = process.platform,
): ShellCall | NotACall => {
  if (event !== events[harness]) return "unreadable"
  const body = record(payload)
  if (body === undefined) return "unreadable"

  let input: Record<string, unknown> | undefined
  if (harness === "agy") {
    const call = record(body["toolCall"])
    if (call === undefined || typeof call["name"] !== "string") return "unreadable"
    if (call["name"] !== "run_command") return "not-shell"
    input = record(call["args"])
  } else {
    if (typeof body["tool_name"] !== "string") return "unreadable"
    if (body["tool_name"] !== "Bash") return "not-shell"
    input = record(body["tool_input"])
  }
  if (input === undefined) return "unreadable"

  const allowed = fields[harness]
  if (Object.keys(input).some((key) => allowed[key] === undefined)) return "extra-fields"
  for (const [key, type] of Object.entries(allowed))
    if (input[key] !== undefined && typeof input[key] !== type) return "unreadable"
  const command = input[harness === "agy" ? "CommandLine" : "command"]
  if (typeof command !== "string" || command === "") return "unreadable"
  if (command.length > maxCommand) return "too-long"

  // Codex on Windows runs the command in PowerShell or cmd, which its payload never names.
  if (harness === "codex" && platform === "win32")
    return { command, cwd: null, dialect: "windows-codex" }
  if (harness !== "claude") return { command, cwd: null }
  return typeof body["cwd"] === "string" ? { command, cwd: body["cwd"] } : "unreadable"
}

/** Antigravity's tools known not to run commands (1.4.10, design B3): closed, by exact name. */
export const agyNonCommandTools: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "ask_question",
  "search_web",
  "list_resources",
  "read_resource",
  "send_message",
])

const novadeckPrefix = "mcp_novadeck_novadeck_"

/** Whether an Antigravity tool is on the closed list, or is one of Novadeck's own MCP tools. */
export const isAgyNonCommandTool = (name: string): boolean =>
  agyNonCommandTools.has(name) || name.startsWith(novadeckPrefix)
