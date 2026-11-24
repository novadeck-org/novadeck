import type { ActivityEvent } from "@novadeck/harness-core/events"
import { fieldsOf, parseFields } from "@novadeck/harness-core/fields"
import { followLines } from "@novadeck/harness-core/follow"
import type { Harness } from "@novadeck/harness-core/harness"
import { at } from "@novadeck/harness-core/items"

import { stoppedType } from "./plugin.js"

/**
 * What a pi session's own file says beside the extension's reports, followed live while it is
 * bound: Novadeck's extension adds an entry of its own (`custom`, `novadeck-stopped`) as each run
 * settles, once its `Stop` report returned, however that hook fared (extension-source.ts). So a
 * turn whose own `Stop` report never reached Novadeck still ends, `recorded`, as Claude Code's
 * `stop_hook_summary` and opencode's `stopped` line end one. The entry says how the run ended: an
 * abort (Escape) or a failure.
 */
export const followTranscript: NonNullable<Harness["watch"]> = async (run, signal, emit) =>
  followLines(run.transcript, signal, (line) => {
    if (!line.includes(stoppedType)) return
    const event = stoppedEvent(line, run)
    if (event) emit(event)
  })

/** The turn's end one line of the file records, where it is the extension's mark of one. */
export const stoppedEvent = (
  line: string,
  run: { readonly sessionId: string; readonly instance: string | null },
): ActivityEvent | undefined => {
  const fields = parseFields(line)
  if (!fields || fields.type !== "custom" || fields.customType !== stoppedType) return undefined
  const data = fieldsOf(fields.data)
  const error = data?.error
  return {
    type: "turn-ended",
    agent: "pi",
    sessionId: run.sessionId,
    instance: run.instance,
    startedAt: typeof data?.at === "number" ? data.at : (at(fields.timestamp) ?? Date.now()),
    outcome:
      error === "aborted"
        ? "interrupted"
        : error === null || error === undefined
          ? "completed"
          : "failed",
    recorded: true,
  }
}
