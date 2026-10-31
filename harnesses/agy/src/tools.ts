import { commandFolder } from "@novadeck/harness-core/decode"
import type { ToolKind } from "@novadeck/harness-core/events"
import { fieldsOf, parseFields, type Fields } from "@novadeck/harness-core/fields"
import {
  novadeckTool,
  oneLine,
  otherRun,
  shortPath,
  sleepOnly,
  textField,
  unquote,
} from "@novadeck/harness-core/tools"
import type { ToolRun } from "@novadeck/protocol"

/** A tool call as a hook names it, and as a request's input holds it. */
export type ToolCall = { readonly name: string; readonly args: Fields }

/** The call `value` holds as `{name, args}`, its arguments `{}` where they are no object. */
export const toolCall = (value: unknown): ToolCall | undefined => {
  const { name, args } = (value ?? {}) as { name?: unknown; args?: unknown }
  if (typeof name !== "string" || name === "") return undefined
  return { name, args: typeof args === "object" && args !== null ? (args as Fields) : {} }
}

/**
 * The tools that write a file, each naming it in its PostToolUse: write_file and edit_file
 * as Path from 1.4 (probed 2026-10-20, 1.4.3), write_to_file and replace_file_content as
 * TargetFile before (probed 2026-10-15, 1.2.14 and 1.3.5: replace_file_content is its only
 * edit tool; a model is offered no multi_replace_file_content).
 */
export const writers: readonly string[] = [
  "write_file",
  "edit_file",
  "write_to_file",
  "replace_file_content",
]

// Where run_command's arguments may hold its command line.
const commandKeys = ["cmd", "command", "CommandLine"]

// Novadeck's MCP tools as Antigravity names them when it loads them eagerly:
// `mcp_novadeck_novadeck_send`.
const eager = /^mcp_novadeck_novadeck_(.+)$/

// Antigravity encodes a lazily loaded MCP tool as `call_mcp_tool` with the server, the tool
// and its arguments (an object, or JSON text) as arguments of its own.
const lazy = "call_mcp_tool"
const novadeckServers: ReadonlySet<string> = new Set(["novadeck", "novadeck_novadeck"])

const lazyRun = (fields: Fields | undefined): ToolRun | undefined => {
  const server = textField(fields, "ServerName")
  const tool = textField(fields, "ToolName")
  if (!server || !tool) return undefined
  const args = fields?.Arguments
  const given = typeof args === "string" ? parseFields(unquote(args)) : fieldsOf(args)
  // Another server's tool shows its name and server.
  return (
    (novadeckServers.has(server) ? novadeckTool(tool, given) : undefined) ?? {
      kind: "other",
      title: tool,
      detail: server,
    }
  )
}

const known = (name: string, fields: Fields | undefined): ToolRun | undefined => {
  const path = (...keys: string[]): string => shortPath(textField(fields, ...keys))
  switch (name) {
    case "run_command":
      return {
        kind: "run",
        title: "Ran",
        detail: oneLine(textField(fields, ...commandKeys)),
      }
    case "view_file":
    case "read_file":
      return {
        kind: "read",
        title: "Read",
        detail: path("file_path", "AbsolutePath", "Path", "path", "notebook_path"),
      }
    case "list_dir":
      return { kind: "read", title: "Listed", detail: path("DirectoryPath", "path") }
    // write_file and edit_file from 1.4, write_to_file and replace_file_content before.
    case "write_file":
    case "write_to_file":
      return { kind: "write", title: "Wrote", detail: path("file_path", "Path", "TargetFile") }
    case "edit_file":
    case "replace_file_content":
    case "multi_replace_file_content":
      return {
        kind: "write",
        title: "Edited",
        detail: path("file_path", "Path", "TargetFile", "notebook_path"),
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

// The folder Antigravity keeps Novadeck's MCP server's descriptor files in, which it reads
// before calling the server's tools.
const descriptors = /(?:^|[\\/])mcp[\\/]novadeck_novadeck[\\/]/

/**
 * The folder a call ran in, for run_command alone: its own `Cwd` where its version takes
 * one (1.2 did; 1.4 refuses it, probed 2026-10-31, 1.4.12), else a leading `cd` in its
 * command line, else `workspace`, the folder of the conversation's workspace. Its string
 * values may be quoted a second time, as `textField` reads them.
 */
export const folderOf = (
  { name, args }: ToolCall,
  workspace: string | undefined,
): string | undefined =>
  name === "run_command"
    ? commandFolder(
        textField(args, ...commandKeys) || undefined,
        workspace,
        textField(args, "Cwd", "cwd") || undefined,
      )
    : undefined

/**
 * What a tool call counts as to the messaging loop guard: see `ToolKind`. `args` is the
 * hook's own: its string values may be quoted a second time.
 */
export const kindOf = (tool: string, args: Fields): ToolKind => {
  if (tool === lazy)
    return textField(args, "ServerName") === "novadeck_novadeck" ? "novadeck" : "work"
  if (tool === "read_file")
    return descriptors.test(textField(args, "file_path", "AbsolutePath", "Path", "path"))
      ? "novadeck"
      : "work"
  if (tool === "run_command") return sleepOnly(textField(args, ...commandKeys)) ? "waiting" : "work"
  return "work"
}
