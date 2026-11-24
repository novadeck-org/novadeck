import type { ActivityEvent } from "@novadeck/harness-core/events"
import { parseFields } from "@novadeck/harness-core/fields"
import { followLines } from "@novadeck/harness-core/follow"
import type { Harness } from "@novadeck/harness-core/harness"
import { flavourOf } from "@novadeck/harness-core/paths"

import { stoppedFolder } from "./plugin.js"

/**
 * What Novadeck's extension records beside its reports, followed live while a session is bound:
 * it marks each run's end as the run settles, once its `Stop` report returned however that hook
 * fared, in a file of its own beside it (`<plugin>/stopped/<session>.jsonl`, never pi's own
 * session file: extension-source.ts). So a turn whose own `Stop` report never reached Novadeck
 * still ends, `recorded`, as Claude Code's `stop_hook_summary` and opencode's `stopped` line end
 * one. The mark says how the run ended: an abort (Escape) or a failure.
 */
export const followTranscript: NonNullable<Harness["watch"]> = async (run, signal, emit) => {
  const plugin = await run.plugin?.()
  if (!plugin || signal.aborted || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(run.sessionId)) return
  const file = flavourOf(plugin).join(plugin, stoppedFolder, `${run.sessionId}.jsonl`)
  await followLines(file, signal, (line) => {
    const event = stoppedEvent(line, run)
    if (event) emit(event)
  })
}

/** The turn's end one line of the extension's file records. */
export const stoppedEvent = (
  line: string,
  run: { readonly sessionId: string; readonly instance: string | null },
): ActivityEvent | undefined => {
  const fields = parseFields(line)
  if (!fields || fields.type !== "stopped" || fields.session_id !== run.sessionId) return undefined
  const error = fields.error
  return {
    type: "turn-ended",
    agent: "pi",
    sessionId: run.sessionId,
    instance: run.instance,
    startedAt: typeof fields.at === "number" ? fields.at : Date.now(),
    outcome:
      error === "aborted"
        ? "interrupted"
        : error === null || error === undefined
          ? "completed"
          : "failed",
    recorded: true,
  }
}
