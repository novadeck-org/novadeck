import type { ToolKind } from "@novadeck/harness-core/events"
import { fieldsOf, parseFields, type Fields } from "@novadeck/harness-core/fields"
import {
  novadeckTool,
  oneLine,
  otherRun,
  shortPath,
  sleepOnly,
  textField,
} from "@novadeck/harness-core/tools"
import type { ToolRun } from "@novadeck/protocol"

/**
 * pi's tools, by the names its model calls them (docs/cli.md, 1.6.0): `read`, `bash`, `edit` and
 * `write` by default, with `grep`, `find` and `ls` where the person turns them on. Novadeck's own
 * come as extension tools, named `novadeck_<tool>`. A skeleton to be settled with the probes.
 */
const novadeck = /^novadeck_(.+)$/

/** The tools that write a file, by its `path`. */
export const writers: ReadonlySet<string> = new Set(["edit", "write"])

const known = (name: string, fields: Fields | undefined): ToolRun | undefined => {
  const path = (...keys: string[]): string => shortPath(textField(fields, ...keys))
  switch (name) {
    case "bash":
      return { kind: "run", title: "Ran", detail: oneLine(textField(fields, "command")) }
    case "read":
      return { kind: "read", title: "Read", detail: path("path") }
    case "write":
      return { kind: "write", title: "Wrote", detail: path("path") }
    case "edit":
      return { kind: "write", title: "Edited", detail: path("path") }
    case "grep":
      return { kind: "search", title: "Searched", detail: oneLine(textField(fields, "pattern")) }
    case "find":
      return { kind: "search", title: "Found files", detail: oneLine(textField(fields, "pattern")) }
    case "ls":
      return { kind: "read", title: "Listed", detail: path("path") }
    default:
      return undefined
  }
}

/**
 * What a pi tool call was, from its name and its input as text (JSON); one it doesn't know shows
 * its name and the first thing its input says.
 */
export const describe = (tool: string, input: string): ToolRun => {
  const fields = parseFields(input)
  const mine = novadeck.exec(tool)?.[1]
  return (
    (mine === undefined ? undefined : novadeckTool(mine, fields)) ??
    known(tool, fields) ??
    otherRun(tool, fields, input)
  )
}

/** What a tool call counts as to the messaging loop guard: see `ToolKind`. */
export const kindOf = (tool: string, input: unknown): ToolKind => {
  if (novadeck.test(tool)) return "novadeck"
  if (tool === "bash") {
    const command = fieldsOf(input)?.command
    return typeof command === "string" && sleepOnly(command) ? "waiting" : "work"
  }
  return "work"
}
