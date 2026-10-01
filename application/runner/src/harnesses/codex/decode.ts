import { isAbsolute, resolve } from "node:path"

import type { Report } from "../../shell/reports.js"
import type { HarnessEvent } from "../events.js"
import {
  absolute,
  callId,
  continuationPrompt,
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
export const decode = ({ event, seq, instance, env, payload }: Report): readonly HarnessEvent[] => {
  const id = sessionId(payload.session_id)
  if (!id || (env.codexThread !== undefined && env.codexThread !== id)) return []
  const base = { agent: "codex", sessionId: id, instance, startedAt: seq } as const
  const tool = text(payload.tool_name) ?? ""
  const actor = text(payload.agent_id) ?? null
  const input = payload.tool_input
  const call =
    typeof input === "object" && input !== null && "command" in input
      ? { command: (input as { command: unknown }).command }
      : input
  switch (event) {
    case "SessionStart": {
      const cwd = absolute(payload.cwd)
      const transcript = absolute(payload.transcript_path)
      const evidence = sessionStart(text(payload.source))
      return [
        {
          type: "session-observed",
          ...base,
          evidence,
          ...(cwd !== undefined && { cwd }),
          ...(transcript !== undefined && { transcript }),
        },
      ]
    }
    case "UserPromptSubmit": {
      // A subagent's prompt is its own work, not the root's turn.
      if (actor) return []
      const prompt = text(payload.prompt)
      // A Stop hook's reason it submits to continue the turn is no prompt of the person's.
      if (prompt && continuationPrompt(prompt))
        return [{ type: "turn-started", ...base, cause: "harness" }]
      return [{ type: "turn-started", ...base, cause: "prompt", ...(prompt && { prompt }) }]
    }
    case "Stop":
      // A subagent's stop ends its own work, not the turn.
      return actor ? [] : [{ type: "turn-ended", ...base, outcome: "completed" }]
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
      return [
        {
          type: "attention-requested",
          ...base,
          requestId: callId(actor, tool, call),
          actor,
          toolName: tool,
          ...subjectOf(input),
          kind: "permission",
        },
      ]
    case "PostToolUse":
      return [
        {
          type: "attention-resolved",
          ...base,
          requestId: callId(actor, tool, call),
          actor,
          toolName: tool,
          loose: false,
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
