import { posix, win32 } from "node:path"

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
import type { HarnessEvent } from "@novadeck/harness-core/events"
import { promptStart } from "@novadeck/harness-core/prompts"
import type { Report } from "@novadeck/harness-core/report"

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
 * `<send_user_message_question_reply>` that names the call (`asyncReplies`).
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
    case "PermissionRequest":
      return [asked(base, actor, tool, input, call, "permission")]
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

/** The tool Codex offers to ask without waiting (0.162.1 on, to a model that lists it). */
const asyncTool = "request_user_input_async"

/**
 * An async question's request by its call's id, which its answers name (their
 * `questionItemId` carries it): the actor is left out, for the answer's prompt is the
 * root's whoever asked.
 */
const asyncRequestId = (call: string): string => callId(null, asyncTool, { call })

// The prompt Codex gives the model for the answers to its async questions (0.165.0): one
// JSON array between the tags, an object per answered question, its `questionItemId` a
// JSON array of the tool, the call's id and the question's place (probed 2026-10-29).
const asyncReply =
  /^\s*<send_user_message_question_reply>\s*(\[[\s\S]*\])\s*<\/send_user_message_question_reply>\s*$/

/**
 * The questions a prompt answers by quoting them as Codex does once the turn that asked
 * ended: `> ` and the question on a line of its own, a blank line, then the answer.
 */
const quoted = (prompt: string): readonly string[] =>
  [...prompt.replace(/\r\n?/g, "\n").matchAll(/(?:^|\n\n)> ([^\n]+)\n\n(?=\S)/g)].map(
    ([, question]) => question!.trim(),
  )

/**
 * The questions a prompt answers, each once, by its call's id and its place in the call,
 * where it is Codex's reply to async questions: one reply for each question answered.
 * None for any other prompt, and for one whose JSON or items are not as probed.
 */
const asyncReplies = (
  prompt: string,
): readonly { readonly call: string; readonly part: number }[] => {
  const body = asyncReply.exec(prompt)?.[1]
  if (body === undefined) return []
  let items: unknown
  try {
    items = JSON.parse(body)
  } catch {
    return []
  }
  if (!Array.isArray(items) || items.length === 0) return []
  const answered = new Map<string, { readonly call: string; readonly part: number }>()
  for (const item of items) {
    const raw = (item as { questionItemId?: unknown } | null)?.questionItemId
    if (typeof raw !== "string") return []
    let place: unknown
    try {
      place = JSON.parse(raw)
    } catch {
      return []
    }
    if (!Array.isArray(place) || place[0] !== asyncTool) return []
    if (typeof place[1] !== "string" || place[1] === "") return []
    if (!Number.isInteger(place[2]) || (place[2] as number) < 0) return []
    answered.set(JSON.stringify(place.slice(1, 3)), { call: place[1], part: place[2] as number })
  }
  return [...answered.values()]
}

/**
 * What an async question's request asks about: its first question's title, and that
 * question's options, as the other question tools' requests give theirs (`subjectOf`
 * reads `question` and `label`, where this tool has `title` and plain strings); and each
 * question's title as a part, as each is answered on its own.
 */
const asyncSubject = (
  input: unknown,
): {
  readonly subject: string | null
  readonly choices: readonly string[]
  readonly parts: readonly string[]
} => {
  const questions = (input as { questions?: unknown } | null)?.questions
  const listed: unknown[] = Array.isArray(questions) ? questions : []
  const [first] = listed
  const { title, options } = (first ?? {}) as { title?: unknown; options?: unknown }
  return {
    parts: listed.map((each) => {
      const named = (each as { title?: unknown } | null)?.title
      return typeof named === "string" ? named.trim() : ""
    }),
    subject: typeof title === "string" ? title.slice(0, 1024) : null,
    choices: (Array.isArray(options) ? options : [])
      .filter((option): option is string => typeof option === "string" && option.length > 0)
      .slice(0, 16)
      .map((option) => option.slice(0, 256)),
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
  own:
    | {
        readonly requestId: string
        readonly subject: string | null
        readonly choices: readonly string[]
        readonly parts: readonly string[]
        readonly detached: true
      }
    | undefined = undefined,
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

// The lines of a patch that name the files it adds, changes, deletes or moves to.
const patchFile = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm

// Whether a patch's PostToolUse response does not say it failed. Codex answers a patch it
// applied "Success. Updated the following files: ..." (seen from the shell's, 0.159.3); a
// text that begins otherwise (a failed verification) names no file. A response of no text
// is no word of failure. Its response for the tool itself is unprobed: the fake model's
// Codex is offered none, and a rollout's completed `FileChange` backs this up.
const applied = (response: unknown): boolean =>
  typeof response !== "string" || response.trim() === "" || /^Success\b/.test(response.trim())

/**
 * The path rules the given paths are written in, whatever host this runs on: a drive
 * letter, a backslash or a UNC prefix make them Windows paths, anything else POSIX.
 */
export const flavourOf = (...paths: (string | undefined)[]): typeof posix =>
  paths.some((path) => path !== undefined && /^[A-Za-z]:[\\/]|^\\\\|\\/.test(path)) ? win32 : posix

/**
 * The files a tool call's patch wrote, as Codex's apply_patch names them in its input,
 * from the session's directory; none for any other call.
 */
export const patched = (input: unknown, cwd: string | undefined): readonly string[] => {
  if (typeof input !== "object" || input === null) return []
  const texts = Object.values(input).filter((value): value is string => typeof value === "string")
  const paths = texts.flatMap((each) =>
    [...each.matchAll(patchFile)].map(([, path]) => path!.trim()),
  )
  return paths.flatMap((path) =>
    flavourOf(path, cwd).isAbsolute(path)
      ? [flavourOf(path).normalize(path)]
      : cwd !== undefined
        ? [flavourOf(path, cwd).resolve(cwd, path)]
        : [],
  )
}

/** The files a permission request for a Codex patch asks to write, from its directory. */
export const patchRequested = (
  tool: string,
  input: unknown,
  cwd: string | undefined,
): readonly string[] => (tool === "apply_patch" ? patched(input, cwd) : [])
