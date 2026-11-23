import type { contract, TerminalAttached, TerminalEvent } from "@novadeck/protocol"
import { WireError } from "@novadeck/wire"
import { follow, type Session } from "@novadeck/wire/client"

import { coded, hasCode, lost, type RunnerErrorCode } from "./errors.js"
import type { RunnerWire } from "./follow.js"

export type TerminalMode = "control" | "observe"

/**
 * What an attachment asks for. `control-else-observe` takes control where it is free and
 * observes where another client holds it, now and after each reconnection, instead of failing
 * with `CONTROL_IN_USE`.
 */
export type AttachMode = TerminalMode | "control-else-observe"

/** Where the runner's `terminals.controls` news reaches the attachments of one connection. */
export type ControlHub = {
  /** Registers an attachment; the returned function removes it. */
  readonly join: (id: string, since: number, set: (mode: TerminalMode) => void) => () => void
  /** What `join` takes as `since`: a count that rises with each control event. */
  readonly now: () => number
}

/**
 * One attachment to a running terminal. Iterate it for screen events; each event is
 * acknowledged when the next one is requested. The attachment follows the runner
 * through reconnections, resuming after the last event it produced, so a consumer
 * sees one continuous stream. A `snapshot` replaces the screen; it is not appended.
 *
 * Iteration ends when the shell exits or the terminal is detached. It throws a
 * `WireError` when the attachment cannot continue, such as `CONTROL_IN_USE` after
 * another client took control during a disconnection; `write` and `resize` then reject with
 * the same code.
 *
 * The mode is live: another client taking control (or this one's `take`) changes it, and a
 * reconnection may too. Where the runner follows `terminals.controls`, the runner client
 * keeps it current; elsewhere it stays as the runner granted it.
 */
export type AttachedTerminal = AsyncIterableIterator<TerminalEvent> & {
  readonly id: string
  /** Control or observe, as it stands now. */
  readonly mode: TerminalMode
  /** Calls `listener` each time `mode` changes; the returned function stops it. */
  onMode(listener: (mode: TerminalMode) => void): () => void
  /**
   * Moves control of the terminal to this attachment (`terminals.take`). With `ifIdleMs` it is
   * refused with `CONTROL_BUSY` while the controller wrote within that long, and with
   * `CONTROL_IN_USE` where the controller can't be told. Needs a runner that supports it
   * (`supports("terminals.take")`).
   */
  take(options?: { readonly ifIdleMs?: number }): Promise<void>
  /** Sends input, including control characters. Never retried; success means accepted. */
  write(data: string): Promise<void>
  resize(size: { readonly cols: number; readonly rows: number }): Promise<void>
  /** Releases this attachment and ends iteration. The shell keeps running. */
  detach(): Promise<void>
}

type Granted = {
  readonly events: AsyncIterableIterator<TerminalAttached | TerminalEvent>
  readonly first: IteratorResult<TerminalAttached | TerminalEvent>
}

/**
 * Attaches to a terminal, resolving once the runner grants it: its events follow the runner
 * across reconnections from the last one read, each acknowledged as the next is asked for.
 */
export const attachTerminal = async (
  connection: RunnerWire,
  id: string,
  wanted: AttachMode,
  hub?: ControlHub,
): Promise<AttachedTerminal> => {
  // Where the runner last put this attachment, from its grants and control news.
  let mode: TerminalMode = wanted === "observe" ? "observe" : "control"
  const listeners = new Set<(mode: TerminalMode) => void>()
  const setMode = (next: TerminalMode): void => {
    if (next === mode) return
    mode = next
    for (const listener of listeners) listener(next)
  }
  const since = hub?.now() ?? 0
  const stream = follow<typeof contract, TerminalAttached | TerminalEvent>(connection, {
    // Each attachment opens with the runner's grant, which a reattachment must also have.
    open: async function* (client, { after, signal }) {
      // The runner refuses over the stream's first read, so that read is part of asking.
      const attach = async (asked: TerminalMode): Promise<Granted> => {
        const events = await client.terminals.attach(
          { terminalId: id, mode: asked, ...(after !== undefined && { afterSequence: after }) },
          { signal },
        )
        return { events, first: await events.next() }
      }
      let granted: Granted
      if (wanted !== "control-else-observe") granted = await attach(wanted)
      else {
        // Control where it is free; where another client holds it, the same terminal watched.
        try {
          granted = await attach("control")
        } catch (error) {
          if (!hasCode(coded(error), "CONTROL_IN_USE")) throw error
          granted = await attach("observe")
        }
      }
      const { events, first } = granted
      if (first.done || first.value.type !== "attached") {
        throw new WireError<RunnerErrorCode>(
          "DISCONNECTED",
          "Runner ended the attachment before granting it.",
        )
      }
      yield first.value
      yield* events
    },
    resume: {
      cursor: (event) => (event.type === "attached" ? undefined : event.sequence),
      ack: (client, sequence) => client.terminals.ack({ terminalId: id, sequence }),
    },
  })
  // Why the attachment couldn't go on, once it couldn't: what its events threw.
  let failure: WireError | undefined
  const read = async () => {
    try {
      return await stream.next()
    } catch (error) {
      failure = coded(error)
      throw failure
    }
  }
  const granted = await read()
  if (granted.done) throw new WireError<RunnerErrorCode>("CLOSED", "Terminal is detached.")
  if (granted.value.type === "attached") mode = granted.value.mode
  const leave = hub?.join(id, since, (next) => setMode(next))
  // The session to send input on, or why this attachment may not send any.
  const inputSession = (requireControl = true): Session<typeof contract> => {
    if (stream.finished === "ended") throw new WireError<RunnerErrorCode>("TERMINAL_EXITED")
    if (stream.finished === "failed" && failure) {
      throw new WireError(failure.code, failure.message, { cause: failure, data: failure.data })
    }
    if (stream.finished) throw new WireError<RunnerErrorCode>("CLOSED", "Terminal is detached.")
    if (requireControl && mode !== "control")
      throw new WireError<RunnerErrorCode>("CONTROL_REQUIRED")
    const session = stream.session
    if (!session?.channel.open) {
      throw new WireError<RunnerErrorCode>("DISCONNECTED", "Terminal is reattaching.")
    }
    return session
  }
  const terminal: AttachedTerminal = {
    id,
    get mode() {
      return mode
    },
    onMode(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    async take(options) {
      const session = inputSession(false)
      try {
        await session.client.terminals.take({
          terminalId: id,
          ...(options?.ifIdleMs !== undefined && { ifIdleMs: options.ifIdleMs }),
        })
      } catch (error) {
        throw lost(error, session)
      }
      setMode("control")
    },
    [Symbol.asyncIterator]: () => terminal,
    async next() {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Events are delivered in order.
        const result = await read()
        if (result.done) {
          leave?.()
          return result
        }
        // A reattachment's grant is the stream's own business, though it may say that control
        // was lost, or won, meanwhile.
        if (result.value.type === "attached") setMode(result.value.mode)
        else return { value: result.value, done: false }
      }
    },
    async return() {
      leave?.()
      await stream.return()
      return { value: undefined, done: true }
    },
    async write(data) {
      const session = inputSession()
      try {
        await session.client.terminals.write({ terminalId: id, data })
      } catch (error) {
        throw lost(error, session)
      }
    },
    async resize(size) {
      const session = inputSession()
      try {
        await session.client.terminals.resize({ terminalId: id, cols: size.cols, rows: size.rows })
      } catch (error) {
        throw lost(error, session)
      }
    },
    async detach() {
      leave?.()
      await stream.return()
    },
  }
  return terminal
}
