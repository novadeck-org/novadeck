// How a runner ends, whoever hosts it: the desktop app's utility process, told by the main
// process, or a standalone runner told by the system (systemd, Docker, a terminal's Ctrl+C).
// Both save every terminal first and then end the shells, so a server's stop keeps what a
// desktop quit keeps. Only what the host itself brings (where the transcript key comes from,
// the desktop's watch on its main process) plugs in.
import type { Log } from "@novadeck/log"

import { logs } from "./log.js"

/** What the lifecycle ends: a runner, or a server around one. */
export type Supervised = {
  /** Saves every terminal's restore state now, as `Runner.persist`. */
  persist(): void
  /** Saves, ends every shell and closes the store, as `Runner.close`. */
  close(): Promise<void>
}

/** Something of the host's that stops as the runner ends, such as a watch's timer. */
export type HostPart = { stop(): void }

/**
 * How long ending may take before the process exits anyway, in ms: under Docker's 10 s
 * between its SIGTERM and its SIGKILL, so the exit is the runner's own.
 */
export const endDeadlineMs = 8_000

export type Lifecycle = {
  /** Saves every terminal's restore state now, as the system ending the session asks. */
  persist(): void
  /**
   * Ends the runner, once: saves every terminal (with the system's word that the session is
   * ending, so no agent the system ends meanwhile counts as ended by the person), stops the
   * host's parts, closes the runner and exits, 0 once closed, 1 when closing failed or
   * outlasted the deadline. A later call waits on the first.
   */
  end(reason: string): Promise<void>
  /** Exits at once with 1, as a second signal asks; what the end saved first stays saved. */
  abort(reason: string): void
}

export const superviseRunner = (options: {
  readonly runner: Supervised
  readonly exit: (code: number) => void
  readonly parts?: readonly HostPart[]
  readonly deadlineMs?: number
  readonly log?: Log
}): Lifecycle => {
  const {
    runner,
    exit,
    parts = [],
    deadlineMs = endDeadlineMs,
    log = logs.for("lifecycle"),
  } = options
  let ending: Promise<void> | undefined
  return {
    persist() {
      if (!ending) runner.persist()
    },
    end(reason) {
      ending ??= (async () => {
        log.info("runner.ending", "The runner is ending.", { data: { reason } })
        for (const part of parts) part.stop()
        // At once, in the same turn as the request: a systemd stop signals the shells with the
        // runner, and what they print on the way out must not be what is kept.
        runner.persist()
        let timer: ReturnType<typeof setTimeout> | undefined
        const late = new Promise<number>((resolve) => {
          timer = setTimeout(() => {
            log.warn("runner.end-late", "The runner did not end in time and exits anyway.", {
              data: { reason, deadlineMs },
            })
            resolve(1)
          }, deadlineMs)
        })
        const closed = runner.close().then(
          () => 0,
          (error: unknown) => {
            log.error("runner.end-failed", "The runner failed to close.", {
              data: { reason },
              err: error,
            })
            return 1
          },
        )
        const code = await Promise.race([closed, late])
        clearTimeout(timer)
        exit(code)
      })()
      return ending
    },
    abort(reason) {
      log.warn("runner.aborted", "The runner was told again to end and exits at once.", {
        data: { reason },
      })
      exit(1)
    },
  }
}

/** The signals that end a runner, per platform. */
export const endingSignals = (platform: NodeJS.Platform): readonly NodeJS.Signals[] =>
  // Windows raises no SIGTERM (TerminateProcess can't be caught): Ctrl+C, Ctrl+Break (as
  // service wrappers send) and the console window closing, which Windows follows with a
  // kill some seconds later.
  platform === "win32" ? ["SIGINT", "SIGBREAK", "SIGHUP"] : ["SIGTERM", "SIGINT", "SIGHUP"]

/**
 * A second signal within this many ms of the first is the same request, as when a terminal's
 * Ctrl+C reaches the runner both directly and forwarded by the script that started it.
 */
export const repeatSignalMs = 1_000

type SignalSource = {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown
  off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown
}

/**
 * Ends the runner on the platform's ending signals (`endingSignals`): the first ends it
 * gracefully, and another one after `repeatSignalMs` exits at once. Returns what removes
 * the listeners.
 */
export const endOnSignals = (
  lifecycle: Pick<Lifecycle, "end" | "abort">,
  options: {
    readonly platform?: NodeJS.Platform
    readonly source?: SignalSource
    readonly now?: () => number
    /** Told of each signal that starts the end, as a CLI prints it. */
    readonly heard?: (signal: NodeJS.Signals) => void
  } = {},
): (() => void) => {
  const {
    platform = process.platform,
    source = process,
    now = () => performance.now(),
    heard,
  } = options
  let first: number | undefined
  const listener = (signal: NodeJS.Signals): void => {
    const at = now()
    if (first === undefined) {
      first = at
      heard?.(signal)
      void lifecycle.end(signal)
    } else if (at - first >= repeatSignalMs) lifecycle.abort(signal)
  }
  const signals = endingSignals(platform)
  for (const signal of signals) source.on(signal, listener)
  return () => {
    for (const signal of signals) source.off(signal, listener)
  }
}
