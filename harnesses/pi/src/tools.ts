import { absolute, commandFolder } from "@novadeck/harness-core/decode"
import type { ToolKind } from "@novadeck/harness-core/events"
import { fieldsOf, parseFields, type Fields } from "@novadeck/harness-core/fields"
import { flavourOf } from "@novadeck/harness-core/paths"
import {
  count,
  novadeckTool,
  oneLine,
  otherRun,
  shortPath,
  sleepOnly,
  textField,
} from "@novadeck/harness-core/tools"
import type { ToolRun } from "@novadeck/protocol"

/**
 * pi's tools, by the names its model calls them (src/core/tools of its coding-agent package,
 * 1.6.0): read, bash, edit and write by default, with grep, find, ls and (on Windows) powershell
 * when chosen, and its built-in extensions' codemode and tool_search. An MCP server's tool, through
 * pi's own MCP, goes by `mcp__<server>__<tool>`. Novadeck's go by `novadeck_<tool>`: its extension
 * gives them to pi itself (extension-source.ts).
 */
const novadeck = /^novadeck_(.+)$/

// Its tools that only find other tools.
const bookkeeping: ReadonlySet<string> = new Set(["tool_search"])

/** The tools that write a file, by its `path` (relative to the session's folder, or absolute). */
export const writers: ReadonlySet<string> = new Set(["edit", "write"])

/** A file a call names, made absolute against the session's folder where it is relative. */
export const pathOf = (input: unknown, cwd: unknown): string | undefined => {
  const path = fieldsOf(input)?.path
  if (typeof path !== "string" || path === "") return undefined
  const whole = absolute(path)
  if (whole !== undefined) return whole
  const folder = absolute(cwd)
  return folder === undefined ? undefined : flavourOf(folder).resolve(folder, path)
}

const known = (name: string, fields: Fields | undefined): ToolRun | undefined => {
  const path = (...keys: string[]): string => shortPath(textField(fields, ...keys))
  switch (name) {
    case "bash":
    case "powershell":
      return { kind: "run", title: "Ran", detail: oneLine(textField(fields, "command")) }
    case "read":
      return { kind: "read", title: "Read", detail: path("path") }
    case "ls":
      return { kind: "read", title: "Listed", detail: path("path") }
    case "write":
      return { kind: "write", title: "Wrote", detail: path("path") }
    // edit takes `path` and `edits[{oldText, newText}]`.
    case "edit": {
      const edits =
        Array.isArray(fields?.edits) && fields.edits.length > 1 ? count(fields.edits, "edit") : ""
      return {
        kind: "write",
        title: "Edited",
        detail: [path("path"), edits].filter(Boolean).join(" · "),
      }
    }
    case "grep":
      return { kind: "search", title: "Searched", detail: oneLine(textField(fields, "pattern")) }
    case "find":
      return { kind: "search", title: "Found files", detail: oneLine(textField(fields, "pattern")) }
    // A script that calls the other tools; what it ran shows as their own calls.
    case "codemode":
      return { kind: "run", title: "Ran a script", detail: oneLine(textField(fields, "code")) }
    case "tool_search":
      return { kind: "search", title: "Found tools", detail: oneLine(textField(fields, "query")) }
    default:
      return undefined
  }
}

/**
 * What a pi tool call was, from its name and its input as text (JSON). Names match without
 * regard to case; one it doesn't know shows its name and the first thing its input says.
 */
export const describe = (tool: string, input: string): ToolRun => {
  const fields = parseFields(input)
  const mcp = novadeck.exec(tool)?.[1]
  return (
    (mcp === undefined ? undefined : novadeckTool(mcp, fields)) ??
    known(tool.toLowerCase(), fields) ??
    otherRun(tool, fields, input)
  )
}

/**
 * The folder a call ran in, for its shells alone: a leading `cd` in its command, else the
 * session's folder. pi keeps no `cd` between calls: each runs in the session's folder.
 */
export const folderOf = (tool: string, input: unknown, cwd: unknown): string | undefined => {
  if (tool !== "bash" && tool !== "powershell") return undefined
  const command = fieldsOf(input)?.command
  return commandFolder(typeof command === "string" ? command : undefined, cwd)
}

/** What a tool call counts as to the messaging loop guard: see `ToolKind`. */
export const kindOf = (tool: string, input: unknown): ToolKind => {
  if (novadeck.test(tool)) return "novadeck"
  if (bookkeeping.has(tool)) return "bookkeeping"
  if (tool === "bash" || tool === "powershell") {
    const command = fieldsOf(input)?.command
    return typeof command === "string" && sleepOnly(command) ? "waiting" : "work"
  }
  return "work"
}
