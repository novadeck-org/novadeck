import { snapshot as serialize, type MouseEncoding, type Screen } from "@novadeck/emulator/headless"

import { TerminalError, type Exit, type TerminalEvent } from "../contract.js"
import { Subscription } from "./subscription.js"

type Snapshot = Extract<TerminalEvent, { type: "snapshot" }>

type Event<T extends TerminalEvent["type"]> = Omit<Extract<TerminalEvent, { type: T }>, "sequence">

/** An event the terminal sequences: what its program drew, a resize, its exit. */
export type Emitted = Event<"output"> | Event<"resized"> | Event<"exited">

/** One owner's attachment: its mode, and the events it reads in order. */
export type Attachment = {
  readonly mode: "control" | "observe"
  /** The next event, once the ack window lets it go; undefined once the attachment ended. */
  next(): Promise<TerminalEvent | undefined>
  cancel(): void
}

/** What the screen shows, for a snapshot: until the host owns the screen, its caller's. */
export type TerminalView = {
  readonly screen: Screen
  readonly cols: number
  readonly rows: number
  readonly exit: Exit | null
  readonly mouse: MouseEncoding
}

export type TerminalOptions = {
  /** An event's size as the transport sends it, which every budget counts. */
  readonly eventBytes: (event: TerminalEvent) => number
  readonly limits: {
    /** The replay ring's bytes: older events leave it, and a cursor before them gets a snapshot. */
    readonly historyBytes: number
    /** An attachment's queued and unacknowledged events, past which it fails `SLOW_CONSUMER`. */
    readonly subscriberBytes: number
    /** What an attachment may have unacknowledged before delivery waits. */
    readonly ackWindowBytes: number
    /** One snapshot, with as much scrollback as fits. */
    readonly snapshotBytes: number
  }
  /** Who controls it at first: the creator, unless its connection was let go meanwhile. */
  readonly controller?: string | undefined
  readonly view: () => TerminalView
}

/**
 * A terminal's events and who reads them: the sequence, a replay ring bounded in bytes, one
 * controller and any number of observers, each attachment queued and acknowledged on its own.
 */
export type Terminal = {
  readonly controller: string | undefined
  /** How many attachments are live. */
  readonly attached: number
  /**
   * Attaches `owner`: from the ring after `after` where it still holds it, else from a
   * snapshot; ended at once, after what it replays, once the terminal has exited. Throws
   * `ALREADY_ATTACHED`, `CONTROL_IN_USE`, `INVALID_CURSOR` or `SNAPSHOT_TOO_LARGE`.
   */
  attach(
    owner: string,
    options: { after?: number | undefined; mode: "control" | "observe" },
  ): Attachment
  /** An attach given up before it attached: control `owner` held without an attachment goes. */
  forgo(owner: string): void
  /** Ends `owner`'s attachment and its control. */
  release(owner: string): void
  /** `owner` read up to `sequence`; an attachment already ended ignores it. */
  ack(owner: string, sequence: number): void
  /** `owner`'s live attachment, to tell whether it's still the same one. */
  attachment(owner: string): Attachment | undefined
  emit(event: Emitted): void
  /** The terminal exited: each attachment ends once it has read what was emitted. */
  finish(): void
  /**
   * A new run in place: attachments end, the ring empties and a sequence number is skipped,
   * so an earlier cursor gets a snapshot. `controller` controls it.
   */
  restarted(controller: string | undefined): void
  /** Ends every attachment and all control, as the host stops. */
  end(): void
}

type Retained = { readonly event: TerminalEvent; readonly bytes: number }

export const createTerminal = (options: TerminalOptions): Terminal => {
  const { eventBytes, limits, view } = options
  let sequence = 0
  let history: Retained[] = []
  let historyBytes = 0
  const subscribers = new Map<string, Subscription>()
  let controller = options.controller

  // Recovery keeps the visible screen; older scrollback is bounded by the snapshot's size.
  const snapshot = (): Snapshot => {
    const { screen, cols, rows, exit, mouse } = view()
    const eventOf = (data: string): Snapshot => ({
      type: "snapshot",
      sequence,
      data,
      cols,
      rows,
      exit,
    })
    const data = serialize(screen, {
      fits: (candidate) => eventBytes(eventOf(candidate)) <= limits.snapshotBytes,
      mouse,
    })
    if (data === undefined)
      throw new TerminalError(
        "SNAPSHOT_TOO_LARGE",
        "Visible terminal screen exceeds the configured snapshot allowance.",
      )
    return eventOf(data)
  }

  const detach = (owner: string, subscription: Subscription) => {
    if (subscribers.get(owner) !== subscription) return
    subscribers.delete(owner)
    if (controller === owner) controller = undefined
  }

  const cancelAll = () => {
    for (const subscription of subscribers.values()) subscription.cancel()
    subscribers.clear()
  }

  return {
    get controller() {
      return controller
    },
    get attached() {
      return subscribers.size
    },
    attach: (owner, { after, mode }) => {
      if (subscribers.has(owner)) throw new TerminalError("ALREADY_ATTACHED")
      if (mode === "control" && controller !== undefined && controller !== owner)
        throw new TerminalError("CONTROL_IN_USE")
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0 || after > sequence))
        throw new TerminalError("INVALID_CURSOR")
      const subscription: Subscription = new Subscription(
        mode,
        limits.subscriberBytes,
        limits.ackWindowBytes,
        () => detach(owner, subscription),
        limits.snapshotBytes,
        eventBytes,
      )
      subscribers.set(owner, subscription)
      if (mode === "control") controller = owner
      else if (controller === owner) controller = undefined
      const first = history[0]?.event.sequence ?? sequence + 1
      try {
        if (after !== undefined && after >= first - 1) {
          for (const { event } of history) if (event.sequence > after) subscription.push(event)
        } else subscription.push(snapshot())
      } catch (error) {
        subscription.cancel()
        detach(owner, subscription)
        throw error
      }
      if (view().exit !== null) subscription.finish()
      return subscription
    },
    forgo: (owner) => {
      if (!subscribers.has(owner) && controller === owner) controller = undefined
    },
    release: (owner) => {
      subscribers.get(owner)?.cancel()
      subscribers.delete(owner)
      if (controller === owner) controller = undefined
    },
    ack: (owner, acknowledged) => {
      if (!Number.isSafeInteger(acknowledged) || acknowledged < 0)
        throw new TerminalError("INVALID_CURSOR")
      subscribers.get(owner)?.ack(acknowledged)
    },
    attachment: (owner) => subscribers.get(owner),
    emit: (emitted) => {
      const event = { ...emitted, sequence: ++sequence } as TerminalEvent
      const bytes = eventBytes(event)
      history.push({ event, bytes })
      historyBytes += bytes
      while (historyBytes > limits.historyBytes) historyBytes -= history.shift()!.bytes
      for (const subscription of subscribers.values()) subscription.push(event)
    },
    finish: () => {
      for (const subscription of subscribers.values()) subscription.finish()
    },
    restarted: (next) => {
      cancelAll()
      sequence += 1
      history = []
      historyBytes = 0
      controller = next
    },
    end: () => {
      cancelAll()
      controller = undefined
    },
  }
}
