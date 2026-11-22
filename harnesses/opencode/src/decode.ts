import {
  absolute,
  errorText,
  folderField,
  planText,
  replied,
  callId,
  sessionId,
  versionName,
  sessionStart,
  shortName,
  subjectOf,
  text,
  withRequestCwd,
} from "@novadeck/harness-core/decode"
import type { EventBase, HarnessEvent } from "@novadeck/harness-core/events"
import { fieldsOf, isFields } from "@novadeck/harness-core/fields"
import { flavourOf } from "@novadeck/harness-core/paths"
import { promptStart } from "@novadeck/harness-core/prompts"
import type { Report } from "@novadeck/harness-core/report"
import { agentLimits, telemetryLimits } from "@novadeck/protocol"

import { folderOf, kindOf, writers } from "./tools.js"

/**
 * opencode's reports, as normalized facts. opencode has no hook commands: Novadeck's plugin
 * (plugin-source.ts) hears its events in its own process and runs Novadeck's hook command
 * for each, under these names. Every report names the session it is about (`session_id`),
 * and those about a subagent's session name its root's as `root`, where opencode's own
 * parent links lead (a `task` call makes a child session, probed 2026-11-22, 1.19.6).
 *
 * SessionStart binds the root session that runs in the terminal: at its first prompt as
 * opencode makes it (`startup`), at launch for a `--session` or `--continue` (`resume`), as
 * the person moves to another one (`switch`), and after a compaction (`compact`). A turn
 * starts with UserPromptSubmit, the person's prompt, and ends with Stop, which opencode's
 * `session.idle` fires however the turn ended: its `error` says an Escape (`Aborted`) or a
 * failure, and `rejected` a permission the person refused, which ends the turn with no error
 * of its own (probed 2026-11-22, 1.19.6). A Stop that delivers messages starts the next turn
 * itself, through opencode's API, as opencode takes no answer that keeps a turn going; that turn's
 * own prompt hook is the plugin's (`continuation`), not the person's, and `Lapsed` says the
 * plugin couldn't start it. Its permission and question
 * dialogs come with ids of their own, and their replies name them: each request is resolved by
 * its reply, never guessed from a tool's result.
 */
export const decode = (report: Report): readonly HarnessEvent[] =>
  withRequestCwd(decodeReport(report), report.payload)

/** Whether a report's session is a subagent's: its root is another. */
const actorOf = (payload: Report["payload"], id: string): string | null => {
  const root = sessionId(payload.root)
  return root !== undefined && root !== id ? id : null
}

const decodeReport = ({ event, seq, instance, payload }: Report): readonly HarnessEvent[] => {
  const id = sessionId(payload.session_id)
  if (!id) return []
  const actor = actorOf(payload, id)
  // A subagent's facts belong to its root's session, which is the terminal's.
  const root = actor === null ? id : (sessionId(payload.root) ?? id)
  const base: EventBase<"opencode"> = {
    agent: "opencode",
    sessionId: root,
    instance,
    startedAt: seq,
  }
  switch (event) {
    case "SessionStart": {
      const source = text(payload.source)
      const cwd = absolute(payload.cwd)
      const transcript = absolute(payload.transcript_path)
      return [
        {
          type: "session-observed",
          ...base,
          evidence: sessionStart(source),
          ...(source === "compact" && { compacted: true }),
          // Its first prompt makes a session: that prompt was in its box, so it is past any
          // screen of its own. A resume's comes as it starts, and no screen of its own stands
          // before its box, so it is at its prompt too (as Claude Code's resume is).
          ...((source === "startup" || source === "switch" || source === "resume") && {
            atPrompt: true,
          }),
          ...(cwd !== undefined && { cwd }),
          ...(transcript !== undefined && { transcript }),
        },
        // The release it runs, which the plugin read from opencode's health route.
        ...(versionName(payload.version) !== undefined
          ? [
              {
                type: "telemetry-observed" as const,
                ...base,
                version: versionName(payload.version)!,
              },
            ]
          : []),
      ]
    }
    // Its interface went home (`/new`, `/clear`): the session it left ends, none is new yet.
    case "SessionLeft":
      return actor === null ? [{ type: "session-left", ...base }] : []
    case "UserPromptSubmit": {
      // The plugin's own prompt, a Stop's delivery, continues the turn `Continued` told of.
      if (actor !== null || payload.continuation === true) return []
      const prompt = typeof payload.prompt === "string" ? payload.prompt : ""
      const agent = text(payload.agent)
      return [
        promptStart(base, prompt, false),
        // Its plan agent plans: it may only read, and writes no file but its plans.
        ...(agent !== undefined
          ? [{ type: "mode-observed" as const, ...base, planning: agent === "plan" }]
          : []),
        ...modelOf(base, payload.model, payload.variant),
      ]
    }
    // The runner continued the turn as it leased the Stop its delivery: that the plugin started
    // the turn tells nothing more. That it couldn't start one gives the turn back up.
    case "Lapsed":
      return actor === null ? [{ type: "turn-lapsed", ...base }] : []
    case "Stop": {
      if (actor !== null) return []
      const error = fieldsOf(payload.error)
      const name = text(error?.name)
      const message = errorText(error?.message)
      const outcome =
        name === "MessageAbortedError" || payload.rejected === true
          ? "interrupted"
          : name !== undefined
            ? "failed"
            : "completed"
      return [
        {
          type: "turn-ended",
          ...base,
          outcome,
          ...(outcome === "failed" && message !== undefined && { error: message }),
          ...(outcome === "failed" && limitedError(name, message) && { limited: true as const }),
          ...replied(payload.last_assistant_message),
        },
        // Its plan agent's answer is its plan: opencode writes one to a file only with its
        // experimental plan mode, whose review is a question (see QuestionRequest).
        ...(payload.agent === "plan" && typeof payload.plan === "string" && payload.plan.trim()
          ? [
              {
                type: "plan-observed" as const,
                ...base,
                actor: null,
                plan: { kind: "text" as const, ...planText(payload.plan) },
              },
            ]
          : []),
        ...usageOf(base, payload.usage),
      ]
    }
    case "SubagentStart": {
      const agent = sessionId(payload.agent_id)
      return agent
        ? [
            {
              type: "subagent-started",
              ...base,
              actor: agent,
              actorType: shortName(payload.agent_type, agentLimits.name) ?? null,
            },
          ]
        : []
    }
    case "SubagentStop": {
      const agent = sessionId(payload.agent_id)
      return agent ? [{ type: "subagent-stopped", ...base, actor: agent }] : []
    }
    case "PermissionRequest": {
      const request = shortName(payload.request_id, agentLimits.name)
      const permission = text(payload.permission)
      if (!request || !permission) return []
      const input = {
        patterns: payload.patterns,
        metadata: payload.metadata,
        always: payload.always,
      }
      const metadata = fieldsOf(payload.metadata)
      const patterns = Array.isArray(payload.patterns) ? payload.patterns : []
      // What it asks about: a command's line, a file's path, an address, else its patterns.
      const subject = subjectOf({
        ...metadata,
        ...(metadata?.command === undefined &&
          metadata?.filepath === undefined && { pattern: patterns.join(" ") }),
        ...(typeof metadata?.filepath === "string" && { file_path: metadata.filepath }),
      })
      return [
        {
          type: "attention-requested",
          ...base,
          requestId: request,
          actor,
          toolName: permission,
          kind: "permission",
          subject: subject.subject,
          choices: ["Allow once", "Allow always", "Reject"],
          input,
        },
      ]
    }
    case "PermissionReplied": {
      const request = shortName(payload.request_id, agentLimits.name)
      return request
        ? [
            {
              type: "attention-resolved",
              ...base,
              requestId: request,
              actor,
              toolName: "",
              loose: false,
              outcome: payload.reply === "reject" ? "settled" : "allowed",
            },
          ]
        : []
    }
    case "QuestionRequest": {
      const request = shortName(payload.request_id, agentLimits.name)
      if (!request) return []
      const input = { questions: payload.questions }
      // Its experimental plan mode's plan_exit asks whether to build the plan it wrote, as a
      // question naming the plan's file relative to the project (tool/plan.ts, 1.19.6).
      const review = payload.tool_name === "plan_exit"
      const file = review ? planFileOf(payload.questions, payload.worktree, payload.cwd) : undefined
      return [
        {
          type: "attention-requested",
          ...base,
          requestId: request,
          actor,
          toolName: review ? "plan_exit" : "question",
          kind: review ? "plan" : "question",
          ...subjectOf(input),
          input,
        },
        ...(file !== undefined
          ? [
              {
                type: "plan-observed" as const,
                ...base,
                actor,
                plan: { kind: "file" as const, path: file },
              },
            ]
          : []),
      ]
    }
    case "QuestionReplied": {
      const request = shortName(payload.request_id, agentLimits.name)
      return request
        ? [
            {
              type: "attention-resolved",
              ...base,
              requestId: request,
              actor,
              toolName: payload.tool_name === "plan_exit" ? "plan_exit" : "question",
              loose: false,
              outcome: payload.rejected === true ? "settled" : "allowed",
            },
          ]
        : []
    }
    case "PostToolUse": {
      const tool = text(payload.tool_name)
      if (!tool) return []
      const input = payload.tool_input
      const path = writers.has(tool) ? absolute(fieldsOf(input)?.filePath) : undefined
      return [
        // A call's result came: what it asked, if anything, is settled, and the root's own call
        // is where a lead's message is delivered (the runner leases at an `attention-resolved`).
        // Its requests go by their own ids, settled by their replies, so this matches none of them.
        {
          type: "attention-resolved" as const,
          ...base,
          requestId: callId(actor, tool, input),
          actor,
          toolName: tool,
          loose: false,
          outcome: "allowed" as const,
        },
        ...(path !== undefined ? [{ type: "file-touched" as const, ...base, actor, path }] : []),
        {
          type: "tool-called",
          ...base,
          actor,
          toolName: tool,
          kind: kindOf(tool, input),
          ...folderField(actor === null ? folderOf(tool, input, payload.cwd) : undefined),
        },
      ]
    }
    default:
      return []
  }
}

/**
 * The plan file a plan_exit question names, relative to the project's root, which is `/`
 * outside a git repository (tool/plan.ts; probed 2026-11-22, 1.19.6: "Plan at tmp/…/plans/x.md"),
 * else to the session's folder where the report names no root.
 */
const planFileOf = (questions: unknown, worktree: unknown, cwd: unknown): string | undefined => {
  const [first] = Array.isArray(questions) ? questions : []
  const asked = fieldsOf(first)?.question
  const named =
    typeof asked === "string" ? /^Plan at (.+?) is complete\./.exec(asked)?.[1] : undefined
  const folder = absolute(worktree) ?? absolute(cwd)
  if (named === undefined) return undefined
  return (
    absolute(named) ?? (folder === undefined ? undefined : flavourOf(folder).resolve(folder, named))
  )
}

/**
 * A failure from a usage limit, as opencode names one: its retry status gives up with an API
 * error whose message says so (`rate limit`, `quota`, `usage limit`, opencode's free tier's
 * "Free usage limit reached" seen 2026-11-22). Read from the message alone: opencode keeps
 * the provider's status code only inside it.
 */
const limitedError = (name: string | undefined, message: string | undefined): boolean =>
  name === "APIError" || name === "UnknownError"
    ? /rate.?limit|quota|usage limit|insufficient.?credits|429/i.test(message ?? "")
    : false

/**
 * The model a prompt runs on, as opencode names it (`provider/model`), and its variant, which
 * is opencode's word for a reasoning effort.
 */
const modelOf = (base: EventBase<"opencode">, model: unknown, variant: unknown): HarnessEvent[] => {
  const fields = fieldsOf(model)
  const provider = text(fields?.providerID)
  const id = text(fields?.modelID)
  if (!provider || !id) return []
  const name = shortName(`${provider}/${id}`, telemetryLimits.model)
  if (!name) return []
  return [
    {
      type: "telemetry-observed",
      ...base,
      model: name,
      effort: shortName(variant, telemetryLimits.effort) ?? null,
    },
  ]
}

// A token count as given, or none.
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

/**
 * How full the context is after a turn, from its latest answer's tokens as opencode counts
 * them (its footer's figure: input, output, reasoning and cache together) and the model's
 * window as its providers list it; the model too.
 */
const usageOf = (base: EventBase<"opencode">, usage: unknown): HarnessEvent[] => {
  const fields = fieldsOf(usage)
  if (!fields) return []
  const tokens = fieldsOf(fields.tokens)
  const cache = fieldsOf(tokens?.cache)
  const occupied =
    count(tokens?.input) +
    count(tokens?.output) +
    count(tokens?.reasoning) +
    count(cache?.read) +
    count(cache?.write)
  const window =
    typeof fields.window === "number" && fields.window > 0 ? Math.floor(fields.window) : null
  const model = modelOf(
    base,
    { providerID: fields.provider, modelID: fields.model },
    fields.variant,
  )
  const named = model[0]?.type === "telemetry-observed" ? model[0] : undefined
  return [
    {
      type: "telemetry-observed",
      ...base,
      ...(isFields(tokens) && occupied > 0 && { context: { occupied, capacity: window } }),
      ...(named && { model: named.model, effort: named.effort }),
    },
  ]
}
