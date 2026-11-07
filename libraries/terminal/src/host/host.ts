import { TerminalError, type TerminalEvent } from "../contract.js"
import { processListing, type Listing } from "../pty/descendants.js"
import type { Disposable, EndBudget, ProcessTrees, PtyOptions } from "../pty/pty.js"
import {
  createTerminal,
  type HostedTerminal,
  type RunSpec,
  type Terminal,
  type TerminalOptions,
} from "./terminal.js"

export type TerminalHostOptions = {
  /** An event's size as the transport sends it, for the terminal `id`. */
  readonly eventBytes: (event: TerminalEvent, id: string) => number
  readonly limits: TerminalOptions["limits"] & {
    /** Terminals open at once, starting ones included; exited ones make room, oldest first. */
    readonly maxTerminals: number
    /** Exited terminals kept for late viewers; past it the oldest go. */
    readonly maxRetained: number
  }
  readonly scrollback: number
  readonly kill: {
    /** How long a program has to end after its kill before it is forced, in milliseconds. */
    readonly graceMs: number
    /** How long what a closed terminal's program started has to end by itself. */
    readonly treeGraceMs: number
    /** How long ending every terminal may take in all as the host shuts down. */
    readonly shutdownTreesMs: number
    /** The tree's grace as the host shuts down. */
    readonly shutdownTreeGraceMs: number
  }
  /** Windows' process trees, which a closed terminal's programs are ended by. */
  readonly trees: ProcessTrees
  /** The pid of the agent terminal `id` runs, whose processes its end follows; if any. */
  readonly follows?: ((id: string) => number | undefined) | undefined
  /** The processes, for `follows`: this system's unless a test plays them. */
  readonly listing?: Listing | undefined
  /** How its ptys start: as a test plays them, and where their programs are kept. */
  readonly pty?: PtyOptions
  /**
   * Tells of a listener of terminal `id`'s `event` that threw, or, as `"parse"`, of output its
   * screen could not parse (see `TerminalOptions.failed`).
   */
  readonly failed?: (error: unknown, event: string, id: string) => void
}

/**
 * A terminal's place, held while its caller starts it: it counts toward `maxTerminals` until
 * `done`, opened or not, as a terminal starting does beside the open ones.
 */
export type Reservation = {
  /** Starts the terminal in its place; a spawn that fails throws `SPAWN_FAILED`. */
  open(spec: RunSpec, controller: string | undefined): Terminal
  /** The caller is done starting it, whether it opened or not. */
  done(): void
}

type Listeners = {
  /** An exited terminal let go, past `maxRetained` or for room: its screen is gone. */
  evicted: (id: string, terminal: Terminal) => void
}

/**
 * The terminals a host keeps: their ids, their limits, how they close and how long an exited
 * or closed one is kept for its viewers.
 */
export type TerminalHost = {
  /**
   * A place for terminal `id`, after letting exited terminals go for room: `TERMINAL_LIMIT`
   * when that makes none, `CLOSING` once the host shuts down. The caller refuses an id open
   * or still read; `open` throws on one.
   */
  reserve(id: string): Reservation
  /** The terminal open or, closed, still read by its viewers. */
  terminal(id: string): Terminal | undefined
  /** Whether terminal `id` is closed but still read by its viewers. */
  draining(id: string): boolean
  /** Whether terminal `id`'s close or the host's shutdown is ending its program. */
  closing(id: string): boolean
  /** Ends terminal `id`'s program and what it started, once its exit is handled. */
  terminate(id: string): Promise<void>
  /**
   * Takes ended terminal `id` out of the open ones: its viewers read the rest, then it goes.
   * Nothing once the host is shutting down.
   */
  remove(id: string): void
  /**
   * Lets ended terminal `id` go at once, as eviction does but for the caller's own reason,
   * with no listener told and its viewers, if any, not drained: its screen is gone with it.
   * Nothing for one whose program still runs, or once the host is shutting down.
   */
  discard(id: string): void
  /** Ends `owner`'s attachments and control, on every terminal, closed ones too. */
  release(owner: string): void
  /**
   * Attaches `owner` to terminal `id` once the draws queued before it are on its screen, and
   * keeps the terminal, exited or closed, until then. In that step it refuses, in this order:
   * `CLOSING` once the host shuts down, whatever the caller's `check` throws, then the
   * terminal's own refusals. Yields `attached` with its mode, then the events. Given up
   * before it attached, as `signal` aborts or `released` says, it attaches nothing and lets
   * go of control `owner` held without an attachment.
   */
  attach(
    id: string,
    owner: string,
    options: { after?: number | undefined; mode: "control" | "observe" },
    o?: { signal?: AbortSignal; released?: () => boolean; check?: () => void },
  ): AsyncGenerator<{ type: "attached"; mode: "control" | "observe" } | TerminalEvent>
  /**
   * Starts a new run of exited terminal `id` in place, keeping it meanwhile. Refuses, in
   * this order: `CLOSING`, `TERMINAL_NOT_FOUND` for one it doesn't hold open, `check`'s
   * refusal, `CLOSING` again for one a `terminate` ended, which stays closing, `CONFLICT`
   * unless it exited and no other restart is under way, then `CONTROL_IN_USE` for another
   * controller. `prepare` does the caller's waiting and gives back its step. Once the draws queued before are drawn, the
   * step runs with `CLOSING` and `check` asked again, and calls `restart` with the new run.
   */
  restart<T>(
    id: string,
    owner: string,
    o: {
      check: () => void
      prepare: () => Promise<
        (restart: (spec: RunSpec, controller: string | undefined, swapped: () => void) => void) => T
      >
    },
  ): Promise<T>
  /** Ends every program within the shutdown's budget, then lets every terminal go. */
  shutdown(): Promise<void>
  on<K extends keyof Listeners>(event: K, listener: Listeners[K]): Disposable
}

type Entry = {
  readonly id: string
  readonly terminal: HostedTerminal
  closing?: Promise<void>
  /** Its shell may have exited while what it left is still ended, which a shutdown waits for. */
  ending?: boolean
  /** In exit order across terminals; eviction goes oldest first. */
  exitOrder: number
  /** Work under way that the terminal must outlast. */
  kept: number
  restarting: boolean
}

export const createTerminalHost = (options: TerminalHostOptions): TerminalHost => {
  const listing = options.listing ?? processListing(options.pty?.platform)
  const { limits, kill } = options
  const open = new Map<string, Entry>()
  const drained = new Map<string, Entry>()
  const reserved = new Set<symbol>()
  const evicted = new Set<Listeners["evicted"]>()
  let exits = 0
  let shutdownBy: number | undefined
  let stopping = false

  // How long a relay or taskkill run may take now: `usual`, or as the host shuts down, what is
  // left of its time, never under a quarter second.
  const runMs = (usual: number) =>
    shutdownBy === undefined ? usual : Math.max(250, Math.min(usual, shutdownBy - Date.now()))

  const evict = (room = false) => {
    const idle = [...open.entries()]
      .filter(
        ([, entry]) =>
          entry.terminal.exit !== null &&
          entry.terminal.attached === 0 &&
          entry.kept === 0 &&
          !entry.ending,
      )
      .toSorted(([, a], [, b]) => a.exitOrder - b.exitOrder)
    let excess = idle.length - limits.maxRetained
    for (const [id, entry] of idle) {
      const full = room && open.size + reserved.size >= limits.maxTerminals
      if (excess <= 0 && !full) return
      excess -= 1
      entry.terminal.gone()
      entry.terminal.dispose()
      open.delete(id)
      for (const listener of evicted) listener(id, entry.terminal)
    }
  }

  const settle = (id: string) => {
    const entry = drained.get(id)
    if (!entry || entry.terminal.attached > 0 || entry.kept > 0) return
    drained.delete(id)
    entry.terminal.dispose()
  }

  /**
   * Ends a terminal's program and what it started (see the pty's `end`), once its exit is
   * handled. A close already waiting as shutdown begins takes no more than shutdown's own
   * time: each relay or taskkill run within what is left of it, and what its program left
   * running ends by shutdown's shorter grace.
   */
  const end = async ({ id, terminal }: Entry) => {
    const agent = options.follows?.(id)
    const budget: EndBudget = {
      run: runMs,
      graceEnds: (began) =>
        shutdownBy === undefined
          ? began + kill.treeGraceMs
          : Math.min(
              began + kill.treeGraceMs,
              shutdownBy - kill.shutdownTreesMs + kill.shutdownTreeGraceMs,
            ),
    }
    await Promise.all([
      terminal.pty.end({
        graceMs: kill.graceMs,
        treeGraceMs: kill.treeGraceMs,
        trees: options.trees,
        budget,
        follow: agent === undefined ? undefined : { agent, listing },
      }),
      terminal.exited,
    ])
  }

  // Keeps terminal `id` from going, exited or closed, until the returned function is called;
  // then a closed one no one reads goes.
  const keep = (id: string) => {
    const entry = open.get(id) ?? drained.get(id)
    if (!entry) return () => {}
    entry.kept += 1
    let done = false
    return () => {
      if (done) return
      done = true
      entry.kept -= 1
      settle(id)
    }
  }

  const terminate = (entry: Entry): Promise<void> => {
    if (entry.closing) return entry.closing
    if (entry.terminal.exit !== null) return entry.terminal.exited
    entry.ending = true
    const ended = () => {
      entry.ending = false
    }
    entry.closing = end(entry)
    entry.closing.then(ended, ended)
    return entry.closing
  }

  return {
    reserve: (id) => {
      if (stopping) throw new TerminalError("CLOSING")
      evict(true)
      if (open.size + reserved.size >= limits.maxTerminals)
        throw new TerminalError("TERMINAL_LIMIT", "Terminal limit reached.")
      const place = Symbol(id)
      reserved.add(place)
      return {
        open: (spec, controller) => {
          // The caller keeps an id from being taken twice; a host never loses one it holds.
          if (open.has(id) || drained.has(id)) throw new Error(`Terminal ${id} is already open.`)
          const terminal = createTerminal({
            eventBytes: (event) => options.eventBytes(event, id),
            limits,
            spec,
            scrollback: options.scrollback,
            controller,
            ...(options.pty && { pty: options.pty }),
            ...(options.failed && {
              failed: (error: unknown, event: string) => options.failed!(error, event, id),
            }),
          })
          const entry: Entry = { id, terminal, exitOrder: 0, kept: 0, restarting: false }
          open.set(id, entry)
          terminal.on("exit", () => {
            exits += 1
            entry.exitOrder = exits
          })
          terminal.on("exited", () => evict())
          return terminal
        },
        done: () => {
          reserved.delete(place)
        },
      }
    },
    terminal: (id) => (open.get(id) ?? drained.get(id))?.terminal,
    draining: (id) => drained.has(id),
    closing: (id) => open.get(id)?.closing !== undefined,
    terminate: (id) => {
      const entry = open.get(id)
      return entry ? terminate(entry) : Promise.resolve()
    },
    remove: (id) => {
      const entry = open.get(id)
      if (!entry || stopping) return
      entry.terminal.gone()
      open.delete(id)
      drained.set(id, entry)
      settle(id)
    },
    discard: (id) => {
      const entry = open.get(id)
      if (!entry || stopping || entry.terminal.exit === null) return
      entry.terminal.gone()
      entry.terminal.dispose()
      open.delete(id)
    },
    release: (owner) => {
      for (const [id, entry] of [...open, ...drained]) {
        entry.terminal.release(owner)
        settle(id)
      }
    },
    attach: async function* (id, owner, how, o = {}) {
      const entry = open.get(id)
      if (!entry) throw new TerminalError("TERMINAL_NOT_FOUND")
      const { terminal } = entry
      const { signal, released = () => false, check } = o
      // An exited terminal stays, and a closed one is still read, until this is attached.
      const kept = keep(id)
      let attachment: ReturnType<Terminal["attach"]> | undefined
      const detach = () => {
        if (!attachment) {
          if (signal?.aborted || released()) terminal.forgo(owner)
          return
        }
        if (terminal.attachment(owner) === attachment) terminal.release(owner)
      }
      const abort = () => {
        attachment?.cancel()
        detach()
      }
      signal?.addEventListener("abort", abort, { once: true })
      try {
        await terminal
          .enqueue(() => {
            if (signal?.aborted || released()) return
            if (stopping) throw new TerminalError("CLOSING")
            check?.()
            attachment = terminal.attach(owner, how)
          })
          .finally(kept)
        if (!attachment) return
        // Control or observation is established before any event arrives.
        yield { type: "attached", mode: attachment.mode }
        while (true) {
          // eslint-disable-next-line no-await-in-loop -- Each delivery waits for its acks.
          const event = await attachment.next()
          if (event === undefined) return
          yield event
        }
      } finally {
        signal?.removeEventListener("abort", abort)
        attachment?.cancel()
        detach()
        settle(id)
        evict()
      }
    },
    restart: async (id, owner, { check, prepare }) => {
      if (stopping) throw new TerminalError("CLOSING")
      const entry = open.get(id)
      if (!entry) throw new TerminalError("TERMINAL_NOT_FOUND")
      check()
      if (entry.closing) throw new TerminalError("CLOSING")
      const { terminal } = entry
      if (terminal.exit === null || entry.restarting)
        throw new TerminalError("CONFLICT", "Only an exited terminal can restart.")
      if (terminal.controller !== undefined && terminal.controller !== owner)
        throw new TerminalError("CONTROL_IN_USE")
      entry.restarting = true
      // An exited terminal stays while it restarts.
      const kept = keep(id)
      try {
        const step = await prepare()
        // The swap waits for the old run's queued work, which still uses its screen.
        return await terminal.enqueue(() => {
          if (stopping) throw new TerminalError("CLOSING")
          check()
          return step((spec, controller, swapped) => terminal.restart(spec, controller, swapped))
        })
      } finally {
        entry.restarting = false
        kept()
      }
    },
    shutdown: async () => {
      stopping = true
      shutdownBy = Date.now() + kill.shutdownTreesMs
      await Promise.all([...open.values()].map(terminate))
      for (const entry of [...open.values(), ...drained.values()]) {
        entry.terminal.gone()
        entry.terminal.end()
        entry.terminal.dispose()
      }
      open.clear()
      drained.clear()
    },
    on: (event, listener) => {
      evicted.add(listener)
      return { dispose: () => evicted.delete(listener) }
    },
  }
}
