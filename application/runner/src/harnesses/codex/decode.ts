import { isAbsolute, resolve } from "node:path"

import type { Report } from "../../shell/reports.js"
import type { HarnessEvent } from "../events.js"
import {
  absolute,
  withRequestCwd,
  callId,
  promptStart,
  replied,
  sessionId,
  sessionStart,
  subjectOf,
  text,
} from "../harness.js"

/**
 * Codex's hooks, as normalized facts.
 *
 * SessionStart names the session running in the terminal, unless a Codex started it: that
 * one runs with another thread in CODEX_THREAD_ID. A turn starts with UserPromptSubmit and
 * ends with Stop, or Interrupt when the person pressed Esc, which also answers "no" to a
 * waiting request. PermissionRequest asks about a tool call, for the root agent or a
 * subagent; the call's PostToolUse from that actor means it was allowed. Codex describes
 * a shell call in the request but not in its result, so a call is known by its command.
 */
// Its hooks name `permission_mode` as `default` even in Plan Mode: its rollout says
// whether it plans.
export const decode = (report: Report): readonly HarnessEvent[] =>
  withRequestCwd(decodeHook(report), report.payload)

const decodeHook = ({ event, seq, instance, env, payload }: Report): readonly HarnessEvent[] => {
  const id = sessionId(payload.session_id)
  if (!id || (env.codexThread !== undefined && env.codexThread !== id)) return []
  const base = { agent: "codex", sessionId: id, instance, startedAt: seq } as const
  const tool = text(payload.tool_name) ?? ""
  const actor = text(payload.agent_id) ?? null
  const input = payload.tool_input
  const call = callOf(input)
  switch (event) {
    case "SessionStart": {
      const cwd = absolute(payload.cwd)
      // An ephemeral thread keeps no rollout, so its hooks give its transcript as null. One
      // forked so is a `/side` conversation, whose start says `fork` at its first prompt:
      // the person asks it on the side and goes back to the thread it forked from, which
      // stays the terminal's session (probed 2026-10-02, 0.159.3). An ephemeral root, as
      // `codex exec --ephemeral` starts, is the terminal's session all the same.
      if (payload.transcript_path == null && payload.source === "fork") return []
      const transcript = absolute(payload.transcript_path)
      const source = text(payload.source)
      const evidence = sessionStart(source)
      return [
        {
          type: "session-observed",
          ...base,
          evidence,
          ...(source === "compact" && { compacted: true }),
          ...(cwd !== undefined && { cwd }),
          ...(transcript !== undefined && { transcript }),
        },
      ]
    }
    case "UserPromptSubmit": {
      // A subagent's prompt is its own work, not the root's turn.
      if (actor) return []
      // A Stop hook's reason it submits to continue the turn is no prompt of the person's.
      // Its turn's id is what its rollout records the turn's end by.
      const turn = text(payload.turn_id)
      return [promptStart({ ...base, ...(turn && { turn }) }, text(payload.prompt) ?? "")]
    }
    case "Stop":
      // A subagent's stop ends its own work, not the turn.
      return actor
        ? []
        : [
            {
              type: "turn-ended",
              ...base,
              outcome: "completed",
              ...replied(payload.last_assistant_message),
            },
          ]
    case "Interrupt":
      // A subagent's own interrupt ends its work, not the turn.
      return actor ? [] : [{ type: "turn-ended", ...base, outcome: "interrupted" }]
    case "SubagentStart":
      return actor
        ? [
            {
              type: "subagent-started",
              ...base,
              actor,
              actorType: text(payload.agent_type) ?? null,
            },
          ]
        : []
    case "SubagentStop":
      return actor ? [{ type: "subagent-stopped", ...base, actor }] : []
    case "PermissionRequest":
      return [asked(base, actor, tool, input, call, "permission")]
    case "PreToolUse":
      // Two tools ask the person with no PermissionRequest: their dialog is up from the
      // call on, and its PostToolUse says it was answered. The hook is registered for
      // these two alone.
      return tool === "request_user_input"
        ? [asked(base, actor, tool, input, call, "question")]
        : tool === "request_permissions"
          ? [asked(base, actor, tool, input, call, "permission")]
          : []
    case "PostToolUse":
      return [
        {
          type: "attention-resolved",
          ...base,
          requestId: callId(actor, tool, call),
          actor,
          toolName: tool,
          loose: tool === "request_user_input",
          outcome: "allowed",
        },
        ...patched(input, absolute(payload.cwd)).map((path): HarnessEvent => ({
          type: "file-touched",
          ...base,
          actor,
          path,
        })),
      ]
    default:
      return []
  }
}

/** A call as its request and its result both know it: a shell call by its command alone. */
export const callOf = (input: unknown): unknown =>
  typeof input === "object" && input !== null && "command" in input
    ? { command: (input as { command: unknown }).command }
    : input

/**
 * An MCP tool's name as Codex's hooks give it: each character of its server and tool
 * outside ASCII letters, digits and `_` as one `_` (`probe-srv` and `probe.srv` both
 * `probe_srv`, `tüch` and `t😀ch` both `t_ch`; probed 0.159.3). Two servers that come out
 * the same each gain a hash of Codex's own (`a_b_e0598e406614`): their names match nothing,
 * so their requests settle only as before, and their dialogs read as none.
 */
export const mcpTool = (server: string, tool: string): string =>
  `mcp__${mcpName(server)}__${mcpName(tool)}`

/** One part of an MCP tool's name as Codex's hooks give it (see `mcpTool`). */
export const mcpName = (name: string): string => name.replace(/\W/gu, "_")

const asked = (
  base: {
    readonly agent: "codex"
    readonly sessionId: string
    readonly instance: string | null
    readonly startedAt: number
  },
  actor: string | null,
  tool: string,
  input: unknown,
  call: unknown,
  kind: "permission" | "question",
): HarnessEvent => ({
  type: "attention-requested",
  ...base,
  requestId: callId(actor, tool, call),
  actor,
  toolName: tool,
  ...subjectOf(input),
  kind,
  input,
})

// The lines of a patch that name the files it adds, changes or moves to.
const patchFile = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm

/**
 * The files a tool call's patch wrote, as Codex's apply_patch names them in its input,
 * from the session's directory; none for any other call.
 */
const patched = (input: unknown, cwd: string | undefined): readonly string[] => {
  if (typeof input !== "object" || input === null) return []
  const texts = Object.values(input).filter((value): value is string => typeof value === "string")
  const paths = texts.flatMap((each) =>
    [...each.matchAll(patchFile)].map(([, path]) => path!.trim()),
  )
  return paths.flatMap((path) =>
    isAbsolute(path) ? [path] : cwd !== undefined ? [resolve(cwd, path)] : [],
  )
}
