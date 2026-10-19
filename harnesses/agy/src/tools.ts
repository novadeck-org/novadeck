import {
  isFields,
  novadeckTool,
  oneLine,
  otherRun,
  parseFields,
  shortPath,
  textField,
  unquote,
  type Fields,
  type ToolRun,
} from "@novadeck/harness-core/tools"

// Novadeck's MCP tools as Antigravity names them when it loads them eagerly:
// `mcp_novadeck_novadeck_send`.
const eager = /^mcp_novadeck_novadeck_(.+)$/

// Antigravity encodes a lazily loaded MCP tool as `call_mcp_tool` with the server, the tool
// and its arguments (an object, or JSON text) as arguments of its own.
const lazy = "call_mcp_tool"
const novadeckServers: ReadonlySet<string> = new Set(["novadeck", "novadeck_novadeck"])

const lazyRun = (fields: Fields | null): ToolRun | undefined => {
  const server = textField(fields, "ServerName")
  const tool = textField(fields, "ToolName")
  if (!server || !tool) return undefined
  const args = fields?.Arguments
  const given = typeof args === "string" ? parseFields(unquote(args)) : isFields(args) ? args : null
  // Another server's tool shows its name and server.
  return (
    (novadeckServers.has(server) ? novadeckTool(tool, given) : undefined) ?? {
      kind: "other",
      title: tool,
      detail: server,
    }
  )
}

const known = (name: string, fields: Fields | null): ToolRun | undefined => {
  const path = (...keys: string[]): string => shortPath(textField(fields, ...keys))
  switch (name) {
    case "run_command":
      return {
        kind: "run",
        title: "Ran",
        detail: oneLine(textField(fields, "cmd", "command", "CommandLine")),
      }
    case "view_file":
    case "read_file":
      return {
        kind: "read",
        title: "Read",
        detail: path("file_path", "AbsolutePath", "path", "notebook_path"),
      }
    case "list_dir":
      return { kind: "read", title: "Listed", detail: path("DirectoryPath", "path") }
    case "write_to_file":
      return { kind: "write", title: "Wrote", detail: path("file_path", "TargetFile") }
    case "replace_file_content":
    case "multi_replace_file_content":
      return {
        kind: "write",
        title: "Edited",
        detail: path("file_path", "TargetFile", "notebook_path"),
      }
    case "grep_search":
      return {
        kind: "search",
        title: "Searched",
        detail: oneLine(textField(fields, "pattern", "Query", "query")),
      }
    case "find_by_name":
      return {
        kind: "search",
        title: "Found files",
        detail: oneLine(textField(fields, "pattern", "Pattern")),
      }
    case "read_url_content":
      return { kind: "web", title: "Fetched", detail: textField(fields, "url", "Url") }
    case "search_web":
      return { kind: "web", title: "Searched the web", detail: textField(fields, "query") }
    default:
      return undefined
  }
}

/**
 * What an Antigravity tool call was, from its name and its input as text (JSON, whose
 * string arguments it may quote a second time). Names match without regard to case; one it
 * doesn't know shows its name and the first thing its input says.
 */
export const describe = (tool: string, input: string): ToolRun => {
  const fields = parseFields(input)
  const mcp = eager.exec(tool)?.[1]
  return (
    (mcp === undefined ? undefined : novadeckTool(mcp, fields)) ??
    (tool === lazy ? lazyRun(fields) : undefined) ??
    known(tool.toLowerCase(), fields) ??
    otherRun(tool, fields, input)
  )
}
