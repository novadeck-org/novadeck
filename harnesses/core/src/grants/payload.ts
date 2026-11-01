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
 * `platform` (the machine the harness runs on): Codex's and Antigravity's there are marked as Windows'.
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

  if (harness === "claude")
    return typeof body["cwd"] === "string" ? { command, cwd: body["cwd"] } : "unreadable"
  // Codex's payload names the session's folder, not necessarily the command's (its `workdir`
  // is in neither hook): a folder to look in for a program of the command's name, no more.
  const session = harness === "codex" && typeof body["cwd"] === "string" ? body["cwd"] : undefined
  // Codex and Antigravity on Windows run the command in PowerShell or cmd, which their
  // payloads never name; Claude Code's Bash tool runs Git Bash there. cmd runs a program of
  // the command's name from the folder it runs in, so a folder that isn't known is no match.
  const transcript = body["transcript_path"]
  const turn = body["turn_id"]
  const rollout =
    harness === "codex" && typeof transcript === "string" && typeof turn === "string"
      ? { path: transcript, turn }
      : undefined
  const folders = {
    ...(session !== undefined && { sessionFolder: session }),
    ...(harness === "codex" && { folderHidden: true as const }),
    ...(rollout !== undefined && { rollout }),
  }
  if (platform === "win32") {
    if (harness === "codex" && session === undefined) return "unreadable"
    return {
      command,
      cwd: null,
      dialect: "windows-quote-free",
      ...folders,
    }
  }
  return { command, cwd: null, ...folders }
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

/**
 * Novadeck's own MCP tools that run no shell command: they speak to Novadeck, which asks the
 * person where it must (an `open_terminal` command is asked of the person by the runner itself).
 * They are the runner's `shell/mcp.ts` list, and a test holds the two together.
 */
export const novadeckMcpTools: ReadonlySet<string> = new Set([
  "ask",
  "tell",
  "done",
  "show",
  "showing",
  "look",
  "close",
  "open_terminal",
  "open_agent",
  "close_terminal",
  "lead",
  "release",
  "send",
  "agents",
  "summarize",
  "feedback",
  "propose_grant",
])

// Antigravity names the server of Novadeck's plugin `novadeck_novadeck`. It calls one of its tools
// either as a function of its own, `mcp_<server>_<tool>`, or through `call_mcp_tool`, whose
// arguments name the server and the tool.
const novadeckServer = "novadeck_novadeck"
const novadeckPrefix = `mcp_${novadeckServer}_`

/**
 * Whether an Antigravity tool call is on the closed list of tools known to run no command, or is
 * one of Novadeck's own MCP tools: matched whole, by the server's exact name and a tool on
 * `novadeckMcpTools`. A lookalike server, another server's tool and a Novadeck name not on the
 * list are none. `args` is the call's arguments, which `call_mcp_tool` names its target in.
 */
export const isAgyNonCommandTool = (name: string, args?: unknown): boolean => {
  if (agyNonCommandTools.has(name)) return true
  if (name.startsWith(novadeckPrefix))
    return novadeckMcpTools.has(name.slice(novadeckPrefix.length))
  if (name !== "call_mcp_tool" || typeof args !== "object" || args === null) return false
  // Antigravity reads these keys without regard to case, so a key that differs only by case
  // may be the one it uses: no such call is taken for Novadeck's. (Two copies of one exact key are
  // read as the last, by Antigravity and by JSON.parse alike.)
  const keys = Object.keys(args)
  if (
    keys.some(
      (key) =>
        (key.toLowerCase() === "servername" && key !== "ServerName") ||
        (key.toLowerCase() === "toolname" && key !== "ToolName"),
    )
  )
    return false
  const { ServerName: server, ToolName: tool } = args as {
    ServerName?: unknown
    ToolName?: unknown
  }
  return server === novadeckServer && typeof tool === "string" && novadeckMcpTools.has(tool)
}
