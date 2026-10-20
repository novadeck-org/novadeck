// Saving a terminal's transcript keeps what its screen showed, secrets included, unless they
// are masked first. Masking reads the text with patterns that can take long on text built to
// make them, so it is done in a thread of its own, with a deadline (see thread.ts): the
// runner's event loop never runs it, and a transcript that takes too long is not kept.
import { logs } from "../log.js"
import { WorkerThread } from "../thread.js"
import type { TranscriptInput } from "./transcriptRedaction.js"

const log = logs.for("terminals")

export type TranscriptRedactor = {
  /**
   * The transcript with its secrets masked and cut to `maxChars`; "" when there is nothing to
   * keep (blank, or not even its visible rows fit); null when it could not be redacted (failed,
   * too slow, no thread); undefined once `signal` aborted or the redactor closed.
   */
  redact(input: TranscriptInput, signal?: AbortSignal): Promise<string | null | undefined>
  close(): Promise<void>
}

export type TranscriptRedactorOptions = {
  /** How long one transcript may take once the thread is up. */
  readonly deadlineMs?: number
  /** The thread's script, for a test to bring its own. */
  readonly script?: URL
}

// Built, the worker is a file beside this one; in the desktop app's bundle it is
// `redactionWorker.js` beside the bundle (see the host's build).
const where = {
  base: import.meta.url,
  built: ["./redactionWorker.js"],
  source: "./redactionWorker.ts",
}

/**
 * The most one transcript may take. Ordinary ones take well under a second, and the worst
 * screens built against the patterns (1,000 lines of scrollback of one wrapped line, 500
 * columns wide) about 1.5 s
 * (docs/transcript-redaction.md has the measurements), so this leaves a machine several times
 * slower its time and still ends a thread that is stuck.
 */
export const transcriptDeadlineMs = 6000

/** A redactor with a thread of its own, started when first needed and ended after a while idle. */
export const createTranscriptRedactor = (
  options: TranscriptRedactorOptions = {},
): TranscriptRedactor => {
  const thread = new WorkerThread<TranscriptInput, string>(where, {
    deadlineMs: options.deadlineMs ?? transcriptDeadlineMs,
    ...(options.script && { script: options.script }),
  })
  return {
    async redact(input, signal) {
      const outcome = await thread.run(input, signal)
      if (typeof outcome === "object") return outcome.value
      if (outcome === undefined) return undefined
      // Never the text: only what happened to it.
      log.warn(
        "terminals.transcript-redaction-failed",
        "The thread that masks secrets in a transcript did not answer",
        { data: { reason: outcome, chars: input.text.length } },
      )
      return null
    },
    close: () => thread.close(),
  }
}
