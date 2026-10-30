import type { contract, TerminalAttached, TerminalEvent } from "@novadeck/protocol"
import { WireError } from "@novadeck/wire"
import { follow, type Session } from "@novadeck/wire/client"

import { lost, type RunnerErrorCode } from "./errors.js"
import type { RunnerWire } from "./follow.js"

export type TerminalMode = "control" | "observe"

/**
 * One attachment to a running terminal. Iterate it for screen events; each event is
 * acknowledged when the next one is requested. The attachment follows the runner
 * through reconnections, resuming after the last event it produced, so a consumer
 * sees one continuous stream. A `snapshot` replaces the screen; it is not appended.
 *
 * Iteration ends when the shell exits or the terminal is detached. It throws a
 * `WireError` when the attachment cannot continue, such as `CONTROL_IN_USE` after
 * another client took control during a disconnection.
 */
export type AttachedTerminal = AsyncIterableIterator<TerminalEvent> & {
  readonly id: string
  readonly mode: TerminalMode
  /** Sends input, including control characters. Never retried; success means accepted. */
  write(data: string): Promise<void>
  resize(size: { readonly cols: number; readonly rows: number }): Promise<void>
  /** Releases this attachment and ends iteration. The shell keeps running. */
  detach(): Promise<void>
}

/**
 * Attaches to a terminal, resolving once the runner grants it: its events follow the runner
 * across reconnections from the last one read, each acknowledged as the next is asked for.
 */
export const attachTerminal = async (
  connection: RunnerWire,
  id: string,
  mode: TerminalMode,
): Promise<AttachedTerminal> => {
  const stream = follow<typeof contract, TerminalAttached | TerminalEvent>(connection, {
    // Each attachment opens with the runner's grant, which a reattachment must also have.
    open: async function* (client, { after, signal }) {
      const events = await client.terminals.attach(
        { terminalId: id, mode, ...(after !== undefined && { afterSequence: after }) },
        { signal },
      )
      const first = await events.next()
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
  const granted = await stream.next()
  if (granted.done) throw new WireError<RunnerErrorCode>("CLOSED", "Terminal is detached.")
  // The session to send input on, or why this attachment may not send any.
  const inputSession = (): Session<typeof contract> => {
    if (stream.finished === "ended") throw new WireError<RunnerErrorCode>("TERMINAL_EXITED")
    if (stream.finished) throw new WireError<RunnerErrorCode>("CLOSED", "Terminal is detached.")
    if (mode !== "control") throw new WireError<RunnerErrorCode>("CONTROL_REQUIRED")
    const session = stream.session
    if (!session?.channel.open) {
      throw new WireError<RunnerErrorCode>("DISCONNECTED", "Terminal is reattaching.")
    }
    return session
  }
  const terminal: AttachedTerminal = {
    id,
    mode,
    [Symbol.asyncIterator]: () => terminal,
    async next() {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Events are delivered in order.
        const result = await stream.next()
        if (result.done) return result
        // A reattachment's grant is the stream's own business.
        if (result.value.type !== "attached") return { value: result.value, done: false }
      }
    },
    async return() {
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
      await stream.return()
    },
  }
  return terminal
}
