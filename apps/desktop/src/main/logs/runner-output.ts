// The runner's output, line by line, in the app's log.

import type { Log } from "@novadeck/log"

/**
 * Calls `line` with each whole line of `stream` that holds more than spaces, then `end` once
 * the stream ends, with what was left of it first.
 */
export const eachLine = (
  stream: NodeJS.ReadableStream | null,
  line: (text: string) => void,
  end?: () => void,
): void => {
  if (!stream) return
  let rest = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    const lines = (rest + chunk).split(/\r?\n/)
    rest = lines.pop() ?? ""
    for (const each of lines) if (each.trim() !== "") line(each)
  })
  stream.on("end", () => {
    if (rest.trim() !== "") line(rest)
    rest = ""
    end?.()
  })
}

/** How many lines of each stream of each start of the runner are logged. */
const outputLimit = 2_000

/** How many of the lines past the limit are kept, the last ones, to be logged as it ends. */
const outputTail = 100

// The caret Node prints under the source line of an error nothing caught.
const caret = /^\s*\^+\s*$/

/** What the app's main process does with each line the runner writes, and with the end of each stream. */
export type RunnerOutput = {
  readonly line: (run: number, stream: "stdout" | "stderr", text: string) => void
  readonly end: (run: number, stream: "stdout" | "stderr") => void
}

/**
 * Logs the runner's output, each line as `runner.stdout` or `runner.stderr`, redacted as
 * every line is.
 *
 * - The line Node prints above its caret (`^`) for an error nothing caught is the source
 *   it failed in, which may hold anything, as the text a JSON.parse was given: it is
 *   withheld, so each line waits for the next before it is written.
 * - Past `limit` lines of a stream in one start of the runner, it says so once
 *   (`runner.stderr-capped`) and keeps only the last `outputTail` lines, written when the
 *   stream ends (`runner.stderr-tail`): what a runner says as it dies, as V8's report of
 *   running out of memory, comes last. The next start logs afresh.
 */
export const logRunnerOutput = (log: Log, limit = outputLimit): RunnerOutput => {
  type Stream = { count: number; held: string | undefined; tail: string[]; dropped: number }
  const streams = new Map<string, Stream>()
  const of = (run: number, stream: string): Stream => {
    const key = `${run} ${stream}`
    const known = streams.get(key)
    if (known) return known
    const fresh: Stream = { count: 0, held: undefined, tail: [], dropped: 0 }
    streams.set(key, fresh)
    return fresh
  }
  const write = (run: number, stream: "stdout" | "stderr", text: string): void =>
    log[stream === "stderr" ? "warn" : "info"](`runner.${stream}`, text, { data: { run } })
  const emit = (run: number, stream: "stdout" | "stderr", state: Stream, text: string): void => {
    state.count += 1
    if (state.count <= limit) return write(run, stream, text)
    if (state.count === limit + 1)
      log.warn(`runner.${stream}-capped`, "The runner wrote more than the log keeps.", {
        data: { run, limit },
      })
    state.dropped += 1
    state.tail.push(text)
    if (state.tail.length > outputTail) state.tail.shift()
  }
  return {
    line(run, stream, text) {
      const state = of(run, stream)
      const held = state.held
      state.held = text
      if (held === undefined) return
      if (!caret.test(text)) return emit(run, stream, state, held)
      emit(run, stream, state, "(a source line was withheld)")
      state.held = undefined
    },
    end(run, stream) {
      const state = of(run, stream)
      if (state.held !== undefined) emit(run, stream, state, state.held)
      state.held = undefined
      if (state.dropped === 0) return
      log.warn(`runner.${stream}-tail`, "The last lines the runner wrote past the limit.", {
        data: { run, dropped: state.dropped, kept: state.tail.length },
      })
      for (const text of state.tail) write(run, stream, text)
      state.tail = []
      state.dropped = 0
    },
  }
}
