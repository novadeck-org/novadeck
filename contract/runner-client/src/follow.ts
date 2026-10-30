import type { contract, WireClient } from "@novadeck/protocol"
import { follow, type Wire } from "@novadeck/wire/client"

import { hasCode } from "./errors.js"

export type RunnerWire = Wire<typeof contract>

/** Says that a fresh sequence of a stream's items begins, replacing what came before. */
export type Reset = { readonly type: "reset" }

type Open<T> = (client: WireClient, signal: AbortSignal) => Promise<AsyncIterable<T>>

/**
 * `agents.detail()`, `agents.transcript()` and the like: one stream per connection, opened again
 * after each reconnection or when the runner ends it, until what it follows (a terminal, an
 * item) is no longer found. A stream opened again starts over; `reset`, where given, says so
 * first.
 */
export const followRestarting = <T>(connection: RunnerWire, open: Open<T>, reset?: T) =>
  follow(connection, {
    open: (client, { signal }) => open(client, signal),
    resume: reset === undefined ? { restart: true } : { restart: true, reset, holdReset: true },
    gone: (error) => hasCode(error, "TERMINAL_NOT_FOUND", "NOT_FOUND"),
  })

/**
 * `terminals.watch()` and `companions.watch()`, which follow all of a kind on the runner: one
 * stream per connection, opened again after each reconnection, each opening with `reset`.
 */
export const followAll = <Change>(connection: RunnerWire, open: Open<Change>) =>
  follow<typeof contract, Change | Reset>(connection, {
    open: (client, { signal }) => open(client, signal),
    resume: { restart: true, reset: { type: "reset" } },
  })
