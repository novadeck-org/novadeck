import type { ToolKind } from "@novadeck/harness-core/events"

/** The tools that write a file. */
export const writers: ReadonlySet<string> = new Set(["edit", "write"])

/** What a tool call counts as to the messaging loop guard. A skeleton: every tool is work. */
export const kindOf = (tool: string, _input: unknown): ToolKind =>
  /^(?:mcp__novadeck__|novadeck_)/.test(tool) ? "novadeck" : "work"
