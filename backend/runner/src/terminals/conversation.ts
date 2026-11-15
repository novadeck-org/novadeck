import type { AgentBox, AgentDetail, PromptReceipt, RequestDialog } from "@novadeck/protocol"

import type { Activity } from "../harnesses/activity.js"
import type { Binding } from "../harnesses/bindings.js"
import { agentDetail } from "../harnesses/detail.js"
import { savedSession } from "./binding/standing.js"
import type { Record } from "./record.js"

/** What a conversation reader needs; saved history never establishes a live binding. */
export type ConversationRecord = Pick<Record, "bound" | "transcript"> &
  Partial<
    Pick<
      Record,
      "agents" | "resumeClaim" | "resumeEnded" | "startupRuns" | "expecting" | "conversationPrompt"
    >
  >

/**
 * The conversation bound in the terminal, or the one its shell is explicitly resuming.
 * Codex reports its resumed session only at the first prompt, after replaying its history.
 * The saved report belongs to that resume alone: cancelling or ending its startup, ending
 * a binding, or starting a fresh agent cannot give that agent the earlier conversation.
 */
export const conversationOf = (
  record: ConversationRecord,
):
  | {
      readonly binding: Binding
      readonly activity: Activity | null
      readonly transcript: string | null
    }
  | undefined => {
  if (record.bound) return { ...record.bound, transcript: record.transcript }
  const saved = savedSession(record)
  if (!saved || !record.startupRuns || record.expecting !== saved.agent) return undefined
  const report = record.agents?.[saved.agent]
  if (report?.sessionId !== saved.sessionId || !report.transcript) return undefined
  const prompt = record.conversationPrompt
  if (
    prompt &&
    (prompt.agent !== saved.agent ||
      (prompt.prefix !== null && !saved.sessionId.startsWith(prompt.prefix)))
  )
    return undefined
  return {
    binding: { ...saved, instance: null },
    activity: null,
    transcript: report.transcript,
  }
}

/** Saved history supplies an identity, while activity and telemetry stay live facts. */
export const conversationDetail = (
  record: Record,
  dialogs: ReadonlyMap<string, RequestDialog>,
  answered: ReadonlySet<string>,
  prompts: readonly PromptReceipt[],
  box: AgentBox | null,
): AgentDetail =>
  agentDetail(
    record.summary.id,
    conversationOf(record)?.binding ?? null,
    record.bound?.activity ?? null,
    record.bound?.telemetry ?? null,
    dialogs,
    answered,
    prompts,
    box,
  )
