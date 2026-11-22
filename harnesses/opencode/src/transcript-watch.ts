import type { ActivityEvent } from "@novadeck/harness-core/events"
import { parseFields } from "@novadeck/harness-core/fields"
import { followLines } from "@novadeck/harness-core/follow"
import type { Harness } from "@novadeck/harness-core/harness"

/**
 * What the transcript Novadeck's plugin writes says beside its hooks, followed live while a
 * session is bound: the plugin writes `{"type":"stopped"}` once its `Stop` report returned, however
 * the hook fared, so a turn whose own `Stop` report never reached Novadeck (its hook failed to
 * run) still ends, `recorded`, as Claude Code's `stop_hook_summary` ends one. A turn Escape
 * interrupted says so too, its answer's `MessageAbortedError`.
 */
export const followTranscript: NonNullable<Harness["watch"]> = async (run, signal, emit) =>
  followLines(run.transcript, signal, (line) => {
    if (!line.includes('"stopped"')) return
    const fields = parseFields(line)
    if (!fields || fields.type !== "stopped") return
    const at = typeof fields.at === "number" ? fields.at : Date.now()
    const event: ActivityEvent = {
      type: "turn-ended",
      agent: "opencode",
      sessionId: run.sessionId,
      instance: run.instance,
      startedAt: at,
      outcome:
        fields.error === "MessageAbortedError" || fields.rejected === true
          ? "interrupted"
          : fields.error === null || fields.error === undefined
            ? "completed"
            : "failed",
      recorded: true,
    }
    emit(event)
  })
