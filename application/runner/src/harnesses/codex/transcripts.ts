import { readdir } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { Harness } from "../harness.js"
import { at, entry, joined, record, textOf } from "../items.js"

// Context Codex writes into the conversation as the person's message.
const context =
  /^\s*(<(environment_context|user_instructions|recommended_plugins|skill|subagent_notification)>|# AGENTS\.md instructions)/

// A command the person ran in shell mode (`!`), with its exit code and output. A command
// that printed nothing leaves `Output:` and the closing tag on lines of their own.
const shell =
  /^\s*<user_shell_command>\n<command>\n([\s\S]*?)\n<\/command>\n<result>\nExit code: (-?\d+)\nDuration: [^\n]*\nOutput:\n([\s\S]*?)\n?<\/result>\n<\/user_shell_command>\s*$/

// How many days after its parent's a subagent's rollout may start: Codex files each
// rollout under the day it starts, and a session can outlast midnight.
const days = 7

const dayFolder = (sessions: string, day: Date): string =>
  join(
    sessions,
    String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, "0"),
    String(day.getDate()).padStart(2, "0"),
  )

// The day folders from `folder` (sessions/YYYY/MM/DD) on, up to `days` of them, then
// today's and yesterday's, for a session resumed long after it began.
const dayFolders = (folder: string): string[] => {
  const match = /(\d{4})[/\\](\d{2})[/\\](\d{2})$/.exec(folder)
  if (!match) return [folder]
  const sessions = dirname(dirname(dirname(folder)))
  const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])]
  const later = Array.from({ length: days }, (_, offset) =>
    dayFolder(sessions, new Date(year, month, date + offset)),
  )
  const now = new Date()
  const recent = [0, 1].map((back) =>
    dayFolder(sessions, new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)),
  )
  return [...new Set([...later, ...recent])]
}

// A call's tool as `mcp__<server>__<tool>`, the way Codex names it elsewhere: its rollout
// records an MCP tool's server apart, as the call's `namespace` (`mcp__novadeck`).
const toolName = (payload: Record<string, unknown>): unknown =>
  typeof payload.namespace === "string" && typeof payload.name === "string"
    ? `${payload.namespace.replace(/_+$/, "")}__${payload.name}`
    : payload.name

/**
 * Codex's transcripts are its rollouts: the session's, and one per subagent, named for
 * its thread and kept under the day it started, its parent's or a later one. Each response item holds the person's or the
 * agent's text, another agent's message to it, a tool call or its output; reasoning
 * stays out, as do developer messages and the context Codex adds as the person's. A
 * command the person ran in shell mode is one user message, which reads as the person's
 * `!command` and a Bash run with its output, and its exit code when not zero.
 */
export const transcripts: NonNullable<Harness["transcripts"]> = {
  locate: async (root, _sessionId, subagent) => {
    if (subagent === null) return root
    const suffix = `-${subagent}.jsonl`
    for (const folder of dayFolders(dirname(root))) {
      // eslint-disable-next-line no-await-in-loop -- The earliest day holding it wins.
      const names = await readdir(folder).catch(() => [])
      const name = names.find((each) => each.startsWith("rollout-") && each.endsWith(suffix))
      if (name) return join(folder, name)
    }
    return undefined
  },
  items: (line) => {
    const fields = record(line)
    if (fields?.type !== "response_item") return []
    const payload = (fields.payload ?? {}) as Record<string, unknown>
    const time = at(fields.timestamp)
    switch (payload.type) {
      case "message": {
        const { role } = payload
        if (role !== "user" && role !== "assistant") return []
        const text = joined(payload.content, ["input_text", "output_text"])
        const ran = role === "user" ? shell.exec(text) : null
        if (ran) {
          const [, command, code, printed] = ran as unknown as [string, string, string, string]
          const output = [printed.trimEnd(), code === "0" ? "" : `[exit code ${code}]`]
            .filter(Boolean)
            .join("\n")
          return [
            entry("user", "text", `!${command}`, { at: time }),
            entry("assistant", "tool-call", JSON.stringify({ command }), {
              at: time,
              tool: "Bash",
              call: payload.id,
            }),
            entry("tool", "tool-result", output || "(no output)", { at: time, call: payload.id }),
          ]
        }
        return text && !context.test(text) ? [entry(role, "text", text, { at: time })] : []
      }
      case "function_call":
      case "custom_tool_call":
        return [
          entry(
            "assistant",
            "tool-call",
            textOf(payload.type === "function_call" ? payload.arguments : payload.input),
            { at: time, tool: toolName(payload), call: payload.call_id },
          ),
        ]
      case "function_call_output":
      case "custom_tool_call_output": {
        const { output } = payload
        const text = Array.isArray(output) ? joined(output, ["input_text"]) : textOf(output)
        return [entry("tool", "tool-result", text, { at: time, call: payload.call_id })]
      }
      // Another agent's message to this one: a subagent's rollout holds its parent's, the
      // root's its subagents', each named by its path (`/root/<name>`).
      case "agent_message": {
        const text = joined(payload.content, ["input_text"])
        return text ? [entry("agent", "text", text, { at: time, author: payload.author })] : []
      }
      default:
        return []
    }
  },
}
