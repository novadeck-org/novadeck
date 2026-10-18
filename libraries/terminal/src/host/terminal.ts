import {
  createScreen,
  snapshot as serialize,
  trackMouse,
  type MouseEncoding,
  type Screen,
} from "@novadeck/emulator/headless"

import { TerminalError, type Exit, type TerminalEvent } from "../contract.js"
import { spawnPty, type Disposable, type NativeSpawn, type Pty, type PtyExit } from "../pty/pty.js"
import { osc7Directory, osc9Directory } from "../shell/osc.js"
import { Subscription } from "./subscription.js"

type Snapshot = Extract<TerminalEvent, { type: "snapshot" }>

type Event<T extends TerminalEvent["type"]> = Omit<Extract<TerminalEvent, { type: T }>, "sequence">

/** An event the terminal sequences: what its program drew, a resize, its exit. */
type Emitted = Event<"output"> | Event<"resized"> | Event<"exited">

// One output event's characters at most.
const outputChars = 4096
// How much read output may wait to be drawn before the program is paused, in characters.
// Pausing for every chunk until it is drawn waits on a timer each time, about 15 ms on
// Windows: a TUI that redraws for every key of a paste, as Codex does there, where the
// paste reaches it as keys, then showed 100 characters in 6 s rather than 0.3 s.
const waitingChars = 256 * 1024

/** One owner's attachment: its mode, and the events it reads in order. */
export type Attachment = {
  readonly mode: "control" | "observe"
  /** The next event, once the ack window lets it go; undefined once the attachment ended. */
  next(): Promise<TerminalEvent | undefined>
  cancel(): void
}

/** A run of the terminal: its program, where it starts and the size it starts at. */
export type RunSpec = {
  readonly file: string
  /** Its arguments, or on Windows its whole command line as one string, as cmd needs one. */
  readonly args: readonly string[] | string
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly cols: number
  readonly rows: number
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
  /** The first run, started at once; a spawn that fails throws `SPAWN_FAILED`. */
  readonly spec: RunSpec
  /** The screen's scrollback, in lines. */
  readonly scrollback: number
  /** Who controls it at first: the creator, unless its connection was let go meanwhile. */
  readonly controller?: string | undefined
  /** The pty as a test plays it (see `spawnPty`). */
  readonly pty?: { readonly native?: NativeSpawn; readonly platform?: NodeJS.Platform }
}

type Listeners = {
  /** A batch reached the screen: inside its draw, before its output is emitted. */
  drawn: () => void
  /** The run exited: inside the exit's draw, before `exited` is emitted. */
  exit: (exit: Exit) => void
  /** The exit was emitted and every attachment finished, in the same draw. */
  exited: () => void
  /** A size took effect on the screen, in its draw, before `resized` is emitted. */
  resized: (size: { cols: number; rows: number }) => void
  title: (title: string, run: Pty) => void
  /** The shell's prompt reported its directory: OSC 7 for this machine, or OSC 9;9. */
  cwd: (cwd: string, run: Pty) => void
  /** A full reset (ESC c) cleared the screen. */
  reset: () => void
}

/**
 * A hosted terminal: a program in a pty, the headless screen it draws on, the events that
 * follow its screen, and who reads them. Draws, resizes, screen reads and attaches wait their
 * turn on one queue, so each sees everything queued before it.
 */
export type Terminal = {
  readonly controller: string | undefined
  /** How many attachments are live. */
  readonly attached: number
  /** The current run's pty. */
  readonly pty: Pty
  /** The current run's screen; read it in `enqueue`, after the draws queued before. */
  readonly screen: Screen
  /** How the mouse is reported on the screen now. */
  mouse(): MouseEncoding
  /** Whether the current run's exit is queued or handled. */
  readonly exiting: boolean
  /** The current run's exit, once handled. */
  readonly exited: Promise<void>
  /**
   * Attaches `owner`: from the ring after `after` where it still holds it, else from a
   * snapshot; ended at once, after what it replays, once the terminal has exited. Throws
   * `ALREADY_ATTACHED`, `CONTROL_IN_USE`, `INVALID_CURSOR` or `SNAPSHOT_TOO_LARGE`. Call it
   * in `enqueue`, so the snapshot shows every draw queued before.
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
  /** Runs `work` once everything queued before it has, draws included. */
  enqueue<T>(work: () => T | Promise<T>): Promise<T>
  /** Resizes the pty now, and the screen once the draws queued before are on it. */
  resize(cols: number, rows: number): void
  /**
   * A new run in place, in an `enqueue` step: `spec` starts, the earlier run's screen and
   * listeners go, attachments end, the ring starts over with a sequence number skipped, so
   * an earlier cursor gets a snapshot, and `controller` controls it. `swapped` runs last, in
   * the same step. Only once the earlier run's exit is handled; a spawn that fails throws
   * `SPAWN_FAILED`, leaving the earlier run as it was.
   */
  restart(spec: RunSpec, controller: string | undefined, swapped: () => void): void
  on<K extends keyof Listeners>(event: K, listener: Listeners[K]): Disposable
  /** Ends every attachment and all control, as the host stops. */
  end(): void
  /** Lets go of the current run's screen and listeners. */
  dispose(): void
}

type Retained = { readonly event: TerminalEvent; readonly bytes: number }

type Run = {
  readonly pty: Pty
  readonly screen: Screen
  readonly mouse: () => MouseEncoding
  readonly startedAt: number
  readonly exited: Promise<void>
  readonly resolveExit: () => void
  disposables: Disposable[]
}

type Read = { readonly run: Pty; readonly data: string }

export const createTerminal = (options: TerminalOptions): Terminal => {
  const { eventBytes, limits } = options
  let sequence = 0
  let history: Retained[] = []
  let historyBytes = 0
  const subscribers = new Map<string, Subscription>()
  let controller = options.controller
  const listeners: { [K in keyof Listeners]: Set<Listeners[K]> } = {
    drawn: new Set(),
    exit: new Set(),
    exited: new Set(),
    resized: new Set(),
    title: new Set(),
    cwd: new Set(),
    reset: new Set(),
  }
  const fire = <K extends keyof Listeners>(event: K, ...args: Parameters<Listeners[K]>) => {
    for (const listener of listeners[event]) (listener as (...all: typeof args) => void)(...args)
  }

  let size = { cols: options.spec.cols, rows: options.spec.rows }
  let exit: Exit | null = null
  let exiting = false
  let chain = Promise.resolve()
  let pendingReads = 0
  let pendingOutput = 0
  // Output read for the draw queued last, and the run each came from, while that draw is
  // still the chain's last work and hasn't begun: later output joins it. Null once it began,
  // or once other work was queued after it, as a resize, which later output must not be
  // drawn ahead of.
  let unread: Read[] | null = null

  const enqueue = <T>(work: () => T | Promise<T>): Promise<T> => {
    // Output read from now on is drawn after this, in a draw of its own.
    unread = null
    const result = chain.then(work)
    chain = result.then(
      () => {},
      () => {},
    )
    return result
  }

  const emit = (emitted: Emitted) => {
    const event = { ...emitted, sequence: ++sequence } as TerminalEvent
    const bytes = eventBytes(event)
    history.push({ event, bytes })
    historyBytes += bytes
    while (historyBytes > limits.historyBytes) historyBytes -= history.shift()!.bytes
    for (const subscription of subscribers.values()) subscription.push(event)
  }

  const spawn = (spec: RunSpec): Run => {
    const screen = createScreen({
      cols: spec.cols,
      rows: spec.rows,
      scrollback: options.scrollback,
    })
    const mouse = trackMouse(screen)
    let pty: Pty
    try {
      pty = spawnPty({ ...spec, ...options.pty })
    } catch {
      screen.dispose()
      throw new TerminalError("SPAWN_FAILED", "Could not start the configured shell.")
    }
    let resolveExit!: () => void
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    return {
      pty,
      screen,
      mouse,
      startedAt: performance.now(),
      exited,
      resolveExit,
      disposables: [],
    }
  }

  let run = spawn(options.spec)

  /**
   * Draws output on the screen in order, after what was queued before it: what arrives
   * while a draw waits joins one batch, drawn by the next. Each draw waits for the screen's
   * callback, a timer, about 15 ms on Windows: a TUI that redraws for every key of a paste,
   * as Codex does there, took over a second to show 100 characters drawn one chunk at a
   * time, though it had drawn them in 0.2 s. The program is paused only while a lot of its
   * output waits (`waitingChars`), and goes on once all of it is drawn, so a program can't
   * outrun its screen.
   */
  const output = (from: Pty, data: string) => {
    pendingOutput += data.length
    if (pendingOutput > waitingChars) from.pause()
    // The draw queued last takes this with it, while nothing was queued after it.
    if (unread) {
      unread.push({ run: from, data })
      return
    }
    const batch: Read[] = [{ run: from, data }]
    pendingReads += 1
    let drawn = 0
    void enqueue(async () => {
      if (unread === batch) unread = null
      drawn = batch.reduce((total, one) => total + one.data.length, 0)
      // Output an earlier run left queued belongs to a screen that is gone.
      const text = batch
        .filter((one) => one.run === run.pty)
        .map((one) => one.data)
        .join("")
      if (text === "") return
      await new Promise<void>((resolve) => run.screen.write(text, resolve))
      fire("drawn")
      for (let start = 0; start < text.length;) {
        let end = Math.min(start + outputChars, text.length)
        const last = text.charCodeAt(end - 1)
        if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1
        emit({ type: "output", data: text.slice(start, end) })
        start = end
      }
    }).finally(() => {
      pendingReads -= 1
      pendingOutput -= drawn
      // Each program of the batch that still runs, as a restart's shell may have been
      // paused in a batch the one before began.
      if (pendingReads === 0 && !exiting)
        for (const one of new Set(batch.map((each) => each.run))) if (one === run.pty) one.resume()
    })
    unread = batch
  }

  const exited = (current: Run, ended: PtyExit) => {
    if (exiting) return
    exiting = true
    const value = {
      ...ended,
      ranMs: Math.max(0, Math.round(performance.now() - current.startedAt)),
    }
    void enqueue(() => {
      exit = value
      fire("exit", value)
      emit({ type: "exited", exit: value })
      for (const subscription of subscribers.values()) subscription.finish()
      current.resolveExit()
      fire("exited")
    })
  }

  const listen = (current: Run) => {
    const { pty, screen } = current
    current.disposables = [
      pty.onData((data) => output(pty, data)),
      pty.onExit((ended) => exited(current, ended)),
      // Device-status queries are answered by the host's screen, even with no viewer.
      screen.onData((data) => {
        if (!exiting) pty.write(data)
      }),
      screen.onTitleChange((title) => fire("title", title, pty)),
      // A shell's integration reports the directory at each prompt: OSC 7 from bash, zsh and
      // fish, OSC 9;9 from PowerShell and cmd. A directory on another machine, as from a
      // shell over SSH, is not this shell's prompt.
      screen.parser.registerOscHandler(7, (data) => {
        const cwd = osc7Directory(data)
        if (cwd !== undefined) fire("cwd", cwd, pty)
        return true
      }),
      // A full reset (ESC c, as `reset` sends) clears the screen; the screen still handles
      // the reset itself.
      screen.parser.registerEscHandler({ final: "c" }, () => {
        fire("reset")
        return false
      }),
      screen.parser.registerOscHandler(9, (data) => {
        const cwd = osc9Directory(data)
        if (cwd === undefined) return false
        fire("cwd", cwd, pty)
        return true
      }),
    ]
  }

  const dispose = () => {
    for (const disposable of run.disposables) disposable.dispose()
    run.screen.dispose()
  }

  const eventOf = (data: string): Snapshot => ({
    type: "snapshot",
    sequence,
    data,
    cols: size.cols,
    rows: size.rows,
    exit,
  })

  // Recovery keeps the visible screen; older scrollback is bounded by the snapshot's size.
  const snapshot = (): Snapshot => {
    const data = serialize(run.screen, {
      fits: (candidate) => eventBytes(eventOf(candidate)) <= limits.snapshotBytes,
      mouse: run.mouse(),
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

  listen(run)

  return {
    get controller() {
      return controller
    },
    get attached() {
      return subscribers.size
    },
    get pty() {
      return run.pty
    },
    get screen() {
      return run.screen
    },
    mouse: () => run.mouse(),
    get exiting() {
      return exiting
    },
    get exited() {
      return run.exited
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
      if (exit !== null) subscription.finish()
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
    enqueue,
    resize: (cols, rows) => {
      run.pty.resize(cols, rows)
      void enqueue(() => {
        run.screen.resize(cols, rows)
        size = { cols, rows }
        fire("resized", { cols, rows })
        emit({ type: "resized", cols, rows })
      })
    },
    restart: (spec, next, swapped) => {
      // A run still going would be orphaned, its exit heard by no one. Once its exit is
      // handled, no step of the earlier run is left to run after the swap.
      if (exit === null) throw new Error("Only an exited terminal restarts.")
      const started = spawn(spec)
      // Earlier attachments ended at the exit; any still draining are dropped.
      cancelAll()
      sequence += 1
      history = []
      historyBytes = 0
      controller = next
      dispose()
      run = started
      size = { cols: spec.cols, rows: spec.rows }
      exit = null
      exiting = false
      // The new run is heard even if its caller's part fails, so its exit still comes.
      try {
        swapped()
      } finally {
        listen(run)
      }
    },
    on: (event, listener) => {
      listeners[event].add(listener)
      return { dispose: () => listeners[event].delete(listener) }
    },
    end: () => {
      cancelAll()
      controller = undefined
    },
    dispose,
  }
}
