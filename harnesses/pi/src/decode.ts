import {
  absolute,
  callId,
  errorText,
  folderField,
  replied,
  sessionId,
  sessionStart,
  shortName,
  text,
  versionName,
  withRequestCwd,
} from "@novadeck/harness-core/decode"
import type { EventBase, HarnessEvent } from "@novadeck/harness-core/events"
import { fieldsOf } from "@novadeck/harness-core/fields"
import { promptStart } from "@novadeck/harness-core/prompts"
import type { Report } from "@novadeck/harness-core/report"
import { agentLimits, telemetryLimits } from "@novadeck/protocol"

import { folderOf, kindOf, pathOf, writers } from "./tools.js"

/**
 * pi's reports, as normalized facts. pi has no hook commands: Novadeck's extension
 * (extension-source.ts) hears its events in its own process and runs Novadeck's hook command for
 * each, under these names (all probed 2026-11-24, 1.6.0, on Novadeck's fake model). Every report
 * names its session (`session_id`); pi has no subagents, so that is always the terminal's.
 *
 * SessionStart binds the session that runs in the terminal, as pi starts it: at launch, a new one
 * (`startup`, its file written with its first message) or one given to resume (`resume`); as the
 * person makes another (`new`, `/new`), moves to one (`resume`, `/resume`) or forks (`fork`); and
 * after a compaction (`compact`). Each of them is at pi's prompt, past its trust and sign-in
 * screens, which come before its sessions start. A turn starts with UserPromptSubmit, the
 * person's prompt (`queued` when given while a run goes on, which the person may still take
 * back), and ends with Stop, which comes once a run settles however it ended: `error` says an
 * abort or a failure. A Stop's delivery goes on in the same run, so the Stop after it is that
 * run's too (`continued`). A person's extension's dialog (DialogShown, DialogEnded) is the only
 * kind pi draws: it names its title alone, and no answer when it goes.
 */
export const decode = (report: Report): readonly HarnessEvent[] =>
  withRequestCwd(decodeReport(report), report.payload)

const decodeReport = ({ event, seq, instance, payload }: Report): readonly HarnessEvent[] => {
  const id = sessionId(payload.session_id)
  if (!id) return []
  const base: EventBase<"pi"> = { agent: "pi", sessionId: id, instance, startedAt: seq }
  switch (event) {
    case "SessionStart": {
      const source = text(payload.source)
      const cwd = absolute(payload.cwd)
      const transcript = absolute(payload.transcript_path)
      const version = versionName(payload.version)
      return [
        {
          type: "session-observed",
          ...base,
          evidence: sessionStart(source),
          ...(source === "compact" && { compacted: true }),
          // A session starts once pi's own screens are past: its prompt shows.
          ...(source !== "compact" && { atPrompt: true }),
          ...(cwd !== undefined && { cwd }),
          ...(transcript !== undefined && { transcript }),
        },
        ...(version !== undefined
          ? [{ type: "telemetry-observed" as const, ...base, version }]
          : []),
        ...modelOf(base, payload.model, payload.effort),
      ]
    }
    case "UserPromptSubmit": {
      const prompt = typeof payload.prompt === "string" ? payload.prompt : ""
      return [promptStart(base, prompt, false), ...modelOf(base, payload.model, payload.effort)]
    }
    case "Stop": {
      const error = fieldsOf(payload.error)
      const name = text(error?.name)
      const message = errorText(error?.message)
      const outcome =
        name === "aborted" ? "interrupted" : name !== undefined ? "failed" : "completed"
      return [
        {
          type: "turn-ended",
          ...base,
          outcome,
          ...(outcome === "failed" && message !== undefined && { error: message }),
          ...(outcome === "failed" && limitedError(message) && { limited: true as const }),
          ...replied(payload.last_assistant_message),
        },
        ...usageOf(base, payload.usage),
      ]
    }
    case "PostToolUse":
    case "NestedToolUse": {
      const tool = text(payload.tool_name)
      if (!tool) return []
      const input = payload.tool_input
      const path = writers.has(tool) ? pathOf(input, payload.cwd) : undefined
      return [
        // A root call's result came: what it asked, if anything, is settled, and it is where a
        // lead's message is delivered (the runner leases at an `attention-resolved`). A call a
        // codemode script made (NestedToolUse) asks nothing: its delivery would wait for the
        // whole script.
        ...(event === "PostToolUse"
          ? [
              {
                type: "attention-resolved" as const,
                ...base,
                requestId: callId(null, tool, input),
                actor: null,
                toolName: tool,
                loose: false,
                outcome: "allowed" as const,
              },
            ]
          : []),
        ...(path !== undefined
          ? [{ type: "file-touched" as const, ...base, actor: null, path }]
          : []),
        {
          type: "tool-called",
          ...base,
          actor: null,
          toolName: tool,
          kind: kindOf(tool, input),
          ...folderField(folderOf(tool, input, payload.cwd)),
        },
      ]
    }
    case "DialogShown": {
      const request = shortName(payload.request_id, agentLimits.name)
      const kind = text(payload.kind)
      if (!request || !kind) return []
      const title = typeof payload.title === "string" ? payload.title : ""
      return [
        {
          type: "attention-requested",
          ...base,
          requestId: request,
          actor: null,
          toolName: kind,
          // A confirmation asks leave; a choice, a line or a text asks an answer.
          kind: kind === "confirm" ? "permission" : "question",
          subject: title.trim() === "" ? null : title,
          choices: [],
          input: { title },
        },
      ]
    }
    case "DialogEnded": {
      const request = shortName(payload.request_id, agentLimits.name)
      const kind = text(payload.kind)
      return request
        ? [
            {
              type: "attention-resolved",
              ...base,
              requestId: request,
              actor: null,
              toolName: kind ?? "",
              loose: false,
              // pi tells no answer: only that the dialog went.
              outcome: "settled",
            },
          ]
        : []
    }
    default:
      return []
  }
}

/**
 * A failure from a usage limit, as pi's providers word one: a 429, or a quota or credit message
 * (pi's own classes, packages/ai/src/utils/retry.ts:10-22, 1.6.0, which it doesn't retry).
 */
const limitedError = (message: string | undefined): boolean =>
  /\b429\b|rate.?limit|quota|usage limit|insufficient.?(?:credits|balance)|out of budget|billing/i.test(
    message ?? "",
  )

/** The model a prompt runs on, as pi names it (`provider/model`), and its thinking level. */
const modelOf = (base: EventBase<"pi">, model: unknown, effort: unknown): HarnessEvent[] => {
  const name = shortName(model, telemetryLimits.model)
  if (!name || !name.includes("/")) return []
  return [
    {
      type: "telemetry-observed",
      ...base,
      model: name,
      effort: shortName(effort, telemetryLimits.effort) ?? null,
    },
  ]
}

/**
 * How full the context is as a run ends, as pi's own footer counts it (`getContextUsage`: the
 * latest answer's tokens, and the model's window), with the model and its thinking level.
 */
const usageOf = (base: EventBase<"pi">, usage: unknown): HarnessEvent[] => {
  const fields = fieldsOf(usage)
  if (!fields) return []
  const tokens =
    typeof fields.tokens === "number" && fields.tokens > 0 ? Math.floor(fields.tokens) : 0
  const window =
    typeof fields.window === "number" && fields.window > 0 ? Math.floor(fields.window) : null
  const named = modelOf(base, fields.model, fields.effort)[0]
  return [
    {
      type: "telemetry-observed",
      ...base,
      ...(tokens > 0 && { context: { occupied: tokens, capacity: window } }),
      ...(named?.type === "telemetry-observed" && { model: named.model, effort: named.effort }),
    },
  ]
}
