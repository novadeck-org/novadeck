import type { TerminalControl } from "@novadeck/protocol"
import type { Terminal } from "@novadeck/terminal/host"
import { KeyedChanges } from "@novadeck/wire/server"

import { DomainError } from "../errors.js"
import type { ClientWindows } from "./client-windows.js"

/** What `Controls` reads of the runner. */
export type ControlsHost = {
  /** The terminal with this id, else TERMINAL_NOT_FOUND. */
  readonly terminal: (id: string) => Terminal
  /** Every terminal the runner holds, with its id. */
  readonly terminals: () => Iterable<readonly [string, Terminal]>
  /** Which client each window is, for the hand-over's choice. */
  readonly clients: () => ClientWindows | undefined
}

/** `null` is the stream's own `synced` mark, which the wire's `terminals.controls` has no use for. */
type Item = TerminalControl | null

/**
 * Who controls each terminal a client is attached to, and how control moves: a client takes it
 * (`terminals.take`), or the controller lets go and an observer is handed it, so the person's
 * other window can type with no click.
 *
 * A client following `terminals.controls` is control-aware: it learns it lost control, so
 * another may take it, and it may be handed it. Older clients never follow, attach as the
 * controller and keep it as ever.
 */
export class Controls {
  /** Each following client's streams, one for each call of `terminals.controls`. */
  private readonly readers = new Map<string, Set<KeyedChanges<string, Item>>>()
  /** When each terminal's controller last wrote, and who it was (see `terminals.take`'s `ifIdleMs`). */
  private readonly writes = new WeakMap<Terminal, { owner: string; at: number }>()

  constructor(private readonly host: ControlsHost) {}

  /** Follows terminal `id`'s control, telling every following client attached to it of each change. */
  watch(id: string, terminal: Terminal): void {
    terminal.on("control", (letGo) => {
      const next = letGo ? this.successor(terminal) : undefined
      if (next !== undefined) terminal.take(next)
      else this.tell(id, terminal)
    })
  }

  /** `owner` attached to the terminal: it learns who controls it now. */
  attached(id: string, terminal: Terminal, owner: string): void {
    this.tell(id, terminal, owner)
  }

  /** The terminal's controller wrote to it. */
  wrote(terminal: Terminal, owner: string): void {
    this.writes.set(terminal, { owner, at: Date.now() })
  }

  /**
   * Moves control of a terminal to `owner`'s attachment, if it may: the controller must follow
   * `controls`, else CONTROL_IN_USE, and with `ifIdleMs`, not have written within it, else
   * CONTROL_BUSY. `owner` not attached is a CONFLICT. A terminal no one controls, or that
   * `owner` does, is taken without those checks.
   */
  take(input: { terminalId: string; ifIdleMs?: number | undefined }, owner: string): void {
    const terminal = this.host.terminal(input.terminalId)
    const { ifIdleMs } = input
    if (!terminal.attachment(owner)) throw new DomainError("CONFLICT")
    const { controller } = terminal
    if (controller !== undefined && controller !== owner) {
      // A controller with no attachment of its own, a creator not yet attached, can be taken from.
      if (terminal.attachment(controller) && !this.follows(controller))
        throw new DomainError("CONTROL_IN_USE")
      const last = this.writes.get(terminal)
      if (ifIdleMs !== undefined && last?.owner === controller && Date.now() - last.at < ifIdleMs)
        throw new DomainError("CONTROL_BUSY")
    }
    terminal.take(owner)
    // A take is the new controller's act: the one before may not take it straight back.
    if (controller !== owner) this.wrote(terminal, owner)
  }

  /**
   * The control items of `owner`'s attachments, as they are and then as they change, until
   * `signal` aborts. The client follows from this call, not from the first item read.
   */
  follow(owner: string, signal?: AbortSignal): AsyncGenerator<TerminalControl> {
    const current: (readonly [string, Item])[] = []
    for (const [id, terminal] of this.host.terminals())
      if (terminal.attachment(owner)) current.push([id, this.itemOf(id, terminal, owner)])
    const reader = new KeyedChanges<string, Item>(current, null)
    const readers = this.readers.get(owner) ?? new Set()
    readers.add(reader)
    this.readers.set(owner, readers)
    const stop = () => {
      reader.finish()
      readers.delete(reader)
      if (readers.size === 0 && this.readers.get(owner) === readers) this.readers.delete(owner)
    }
    signal?.addEventListener("abort", stop, { once: true })
    if (signal?.aborted) stop()
    return (async function* () {
      try {
        while (true) {
          // eslint-disable-next-line no-await-in-loop -- Items are read in order.
          const item = await reader.next()
          if (item === undefined) return
          if (item !== null) yield item
        }
      } finally {
        signal?.removeEventListener("abort", stop)
        stop()
      }
    })()
  }

  /** Whether `owner` follows `controls` now. */
  follows(owner: string): boolean {
    return this.readers.has(owner)
  }

  /** The client has gone: its streams end, and it is no one's successor. */
  release(owner: string): void {
    for (const reader of this.readers.get(owner) ?? []) reader.finish()
    this.readers.delete(owner)
  }

  /** Ends every stream, as the runner shuts down. */
  finish(): void {
    for (const owner of this.readers.keys()) this.release(owner)
  }

  /**
   * Who is handed a terminal its controller let go of: of those attached and following, the one
   * its client used last (see `ClientWindows`), else the one that attached last.
   */
  private successor(terminal: Terminal): string | undefined {
    const aware = terminal.owners.filter((owner) => this.follows(owner))
    return this.host.clients()?.lastUsed(aware) ?? aware.at(-1)
  }

  private itemOf(id: string, terminal: Terminal, owner: string): TerminalControl {
    const { controller } = terminal
    return {
      type: "control",
      terminalId: id,
      holder: controller === owner ? "you" : controller === undefined ? "none" : "other",
    }
  }

  /** Tells the following clients attached to the terminal (only `to`, where named) who controls it. */
  private tell(id: string, terminal: Terminal, to?: string): void {
    for (const owner of to === undefined ? terminal.owners : [to]) {
      const item = this.itemOf(id, terminal, owner)
      for (const reader of this.readers.get(owner) ?? []) reader.changed(id, item)
    }
  }
}
