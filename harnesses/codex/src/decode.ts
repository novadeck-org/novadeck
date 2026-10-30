import {
  absolute,
  withRequestCwd,
  callId,
  replied,
  sessionId,
  sessionStart,
  subjectOf,
  text,
} from "@novadeck/harness-core/decode"
import type { EventBase, HarnessEvent } from "@novadeck/harness-core/events"
import { promptStart } from "@novadeck/harness-core/prompts"
import type { Report } from "@novadeck/harness-core/report"

import { asyncReplies, asyncRequestId, asyncSubject, asyncTool, quoted } from "./async-question.js"
import { applied, patched } from "./patch.js"
import { kindOf } from "./tools.js"

/**
 * Codex's hooks, as normalized facts.
 *
 * SessionStart names the session running in the terminal, unless a Codex started it: that
 * one runs with another thread in CODEX_THREAD_ID. A turn starts with UserPromptSubmit and
 * ends with Stop, or Interrupt when the person pressed Esc, which also answers "no" to a
 * waiting request. PermissionRequest asks about a tool call, for the root agent or a
 * subagent; the call's PostToolUse from that actor means it was allowed. Codex describes
 * a shell call in the request but not in its result, so a call is known by its command.
 * `request_user_input_async` is the exception: it returns `{"accepted":true}` at once and
 * the turn runs on, so its PostToolUse answers nothing, the request outlives the turn
 * (`detached`), and the person's answer comes back as a prompt of Codex's own, a
 * `<send_user_message_question_reply>` that names the call (`asyncReplies`). Its hooks name
 * `permission_mode` as `default` even in Plan Mode: its rollout says whether it plans.
 */
export const decode = (report: Report): readonly HarnessEvent[] =>
  withRequestCwd(decodeHook(report), report.payload)

const decodeHook = ({ event, seq, instance, env, payload }: Report): readonly HarnessEvent[] => {
  const id = sessionId(payload.session_id)
  if (!id || (env.codexThread !== undefined && env.codexThread !== id)) return []
  const base: EventBase<"codex"> = { agent: "codex", sessionId: id, instance, startedAt: seq }
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
      const prompt = text(payload.prompt) ?? ""
      // Codex's own prompt: the answers the person gave its async question go in at the
      // next model call, which starts a turn of its own when none runs. It settles the
      // requests it names, and is no prompt of the person's.
      const replies = asyncReplies(prompt)
      if (replies.length > 0) {
        return [
          promptStart({ ...base, ...(turn && { turn }) }, prompt, true),
          ...replies.map(({ call: named, part }): HarnessEvent => ({
            type: "attention-resolved",
            ...base,
            requestId: asyncRequestId(named),
            actor: null,
            toolName: asyncTool,
            loose: false,
            // As a prompt answered it, not the tool's result, which came at the call.
            outcome: "settled",
            part,
          })),
        ]
      }
      const started = promptStart({ ...base, ...(turn && { turn }) }, prompt)
      // Once its turn ended, Codex answers an async question with a prompt quoting it,
      // which the person's own may do as well: the questions it quotes are answered.
      const answers = quoted(prompt)
      return [
        started.type === "turn-started" && started.cause === "prompt" && answers.length > 0
          ? { ...started, answers }
          : started,
      ]
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
    case "PermissionRequest": {
      // A patch's permission names the files it writes, from the directory it asked in: a
      // patch run through its shell fires no PostToolUse, so its write settles it.
      const writes = tool === "apply_patch" ? patched(input, absolute(payload.cwd)) : []
      return [
        asked(
          base,
          actor,
          tool,
          input,
          call,
          "permission",
          writes.length > 0 ? { writes } : undefined,
        ),
      ]
    }
    case "PreToolUse":
      // Two tools ask the person with no PermissionRequest: their dialog is up from the
      // call on, and its PostToolUse says it was answered. A third, the async question,
      // asks without waiting (see above). The hook is registered for these three alone.
      return tool === "request_user_input"
        ? [asked(base, actor, tool, input, call, "question")]
        : tool === "request_permissions"
          ? [asked(base, actor, tool, input, call, "permission")]
          : tool === asyncTool
            ? [
                // Named by its call alone, so the reply that answers it can find it.
                asked(base, actor, tool, input, call, "question", {
                  requestId: asyncRequestId(text(payload.tool_use_id) ?? ""),
                  ...asyncSubject(input),
                  detached: true,
                }),
              ]
            : []
    case "PostToolUse":
      return [
        // The async question's own result is `{"accepted":true}`, at the call: no answer.
        ...(tool === asyncTool
          ? []
          : [
              {
                type: "attention-resolved",
                ...base,
                requestId: callId(actor, tool, call),
                actor,
                toolName: tool,
                loose: tool === "request_user_input",
                outcome: "allowed",
              } satisfies HarnessEvent,
            ]),
        ...(applied(payload.tool_response)
          ? patched(input, absolute(payload.cwd)).map((path): HarnessEvent => ({
              type: "file-touched",
              ...base,
              actor,
              path,
            }))
          : []),
        { type: "tool-called", ...base, actor, toolName: tool, kind: kindOf(tool, input) },
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
 * A request waiting on the person for a tool call, named by its call unless `own` names it,
 * with the files it asks to write where it names them.
 */
const asked = (
  base: EventBase<"codex">,
  actor: string | null,
  tool: string,
  input: unknown,
  call: unknown,
  kind: "permission" | "question",
  own?:
    | {
        readonly requestId: string
        readonly subject: string | null
        readonly choices: readonly string[]
        readonly parts: readonly string[]
        readonly detached: true
      }
    | { readonly writes: readonly string[] },
): HarnessEvent => ({
  type: "attention-requested",
  ...base,
  requestId: callId(actor, tool, call),
  actor,
  toolName: tool,
  ...subjectOf(input),
  kind,
  input,
  ...own,
})
