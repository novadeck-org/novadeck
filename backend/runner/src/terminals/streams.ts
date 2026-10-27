import type {
  AgentDetail,
  TerminalChange,
  TerminalMessages,
  TerminalSummary,
} from "@novadeck/protocol"
import { Latest } from "@novadeck/wire/server"

import { TerminalWatcher } from "./watcher.js"

export type StreamsHost<R> = {
  /** The runner is stopping: no listing is told any more. */
  readonly stopping: () => boolean
  /** Whether the runner holds the terminal, running or retained. */
  readonly holds: (terminalId: string) => boolean
  /** What the agent in a terminal does, in detail, as `agents.detail` shows it. */
  readonly detail: (record: R) => AgentDetail
  /** A terminal's threads and messages with their states. */
  readonly messages: (terminalId: string) => TerminalMessages
}

/**
 * Who reads the terminals: each `watch` stream and the owner whose release ends it, and
 * each terminal's `agents.detail` and `messages.watch` readers.
 */
export class Streams<R extends { readonly summary: { readonly id: string } }> {
  /** Each `watch` stream and the owner whose release ends it. */
  private readonly watchers = new Map<TerminalWatcher, string>()
  /** Each terminal's `agents.detail` readers. */
  private readonly details = new Map<string, Set<Latest<AgentDetail>>>()
  /** Each terminal's `messages.watch` readers. */
  private readonly messages = new Map<string, Set<Latest<TerminalMessages>>>()

  constructor(readonly host: StreamsHost<R>) {}

  /**
   * A `changed` for every terminal `list` gives, `synced`, then later changes, until the
   * signal aborts, the owner is released, or the runner shuts down.
   */
  async *watch(
    ownerId: string,
    list: () => TerminalSummary[],
    signal?: AbortSignal,
  ): AsyncGenerator<TerminalChange> {
    const watcher = new TerminalWatcher(list())
    this.watchers.set(watcher, ownerId)
    const abort = () => watcher.finish()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) watcher.finish()
    try {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Changes are delivered in order.
        const change = await watcher.next()
        if (change === undefined) return
        yield change
      }
    } finally {
      signal?.removeEventListener("abort", abort)
      watcher.finish()
      this.watchers.delete(watcher)
    }
  }

  /** Tells every watcher of a terminal's summary, made for each as it is told. */
  changed(summary: () => TerminalSummary): void {
    for (const watcher of this.watchers.keys()) watcher.changed(summary())
  }

  /** Tells every watcher a terminal is gone. */
  removed(terminal: Pick<TerminalSummary, "id" | "sessionId">): void {
    for (const watcher of this.watchers.keys()) watcher.removed(terminal)
  }

  /** The record's detail, then another on each change, until it is finished or `signal` aborts. */
  watchDetail(record: R, signal: AbortSignal | undefined): AsyncGenerator<AgentDetail> {
    return this.snapshots(this.details, record.summary.id, this.host.detail(record), signal)
  }

  /** The terminal's listing, then another on each change, until it is finished or `signal` aborts. */
  watchMessages(
    terminalId: string,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<TerminalMessages> {
    return this.snapshots(this.messages, terminalId, this.host.messages(terminalId), signal)
  }

  /** Tells the terminal's detail readers of a change; each drops one it already has. */
  detailed(record: R): void {
    const readers = this.details.get(record.summary.id)
    if (!readers) return
    const detail = this.host.detail(record)
    for (const reader of readers) reader.push(detail)
  }

  /** Tells the terminal's message watchers what its listing says now. */
  messagesChanged(terminalId: string): void {
    const readers = this.messages.get(terminalId)
    if (!readers?.size || this.host.stopping() || !this.host.holds(terminalId)) return
    const listing = this.host.messages(terminalId)
    const key = JSON.stringify(listing)
    for (const reader of readers) reader.push(listing, key)
  }

  /** The terminals whose messages someone watches. */
  messagesWatched(): IterableIterator<string> {
    return this.messages.keys()
  }

  /** Ends the terminal's detail and messages streams, as it is closed. */
  end(terminalId: string): void {
    for (const streams of [this.details, this.messages]) {
      for (const reader of streams.get(terminalId) ?? []) reader.finish()
      streams.delete(terminalId)
    }
  }

  /** Ends the watch streams the owner holds, as it is released. */
  release(ownerId: string): void {
    for (const [watcher, owner] of this.watchers) if (owner === ownerId) watcher.finish()
  }

  /** Ends every watch stream, as the runner shuts down. */
  finishWatchers(): void {
    for (const watcher of this.watchers.keys()) watcher.finish()
  }

  /** Ends every detail and messages stream, as the runner shuts down. */
  finishReaders(): void {
    for (const streams of [this.details, this.messages])
      for (const readers of streams.values()) for (const reader of readers) reader.finish()
  }

  /**
   * A terminal's snapshots, from `first`, as they are pushed to `streams`' readers,
   * until they are finished or `signal` aborts.
   */
  private async *snapshots<T>(
    streams: Map<string, Set<Latest<T>>>,
    terminalId: string,
    first: T,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<T> {
    const reader = new Latest<T>()
    reader.push(first)
    const readers = streams.get(terminalId) ?? new Set()
    streams.set(terminalId, readers.add(reader))
    const abort = () => reader.finish()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) reader.finish()
    try {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Snapshots are delivered in order.
        const next = await reader.next()
        if (next === undefined) return
        yield next
      }
    } finally {
      signal?.removeEventListener("abort", abort)
      reader.finish()
      readers.delete(reader)
      if (readers.size === 0 && streams.get(terminalId) === readers) streams.delete(terminalId)
    }
  }
}
