import {
  createScreen,
  mouseReporting,
  readScreen,
  replay as replayOn,
  snapshot as serialize,
  trackMouse,
  type MouseEncoding,
  type Reporting,
  type Screen,
  type ScreenText,
} from "@novadeck/emulator/headless"

import { TerminalError, type Exit, type TerminalEvent } from "../contract.js"
import { spawnPty, type Disposable, type NativeSpawn, type Pty, type PtyExit } from "../pty/pty.js"
import { osc7Directory, osc9Directory } from "../shell/osc.js"
import { splitReports } from "./reports.js"
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

/** How long a hold's safety caps let it last, in milliseconds. */
export type HoldBudget = {
  /** How long the person's input is held at most. */
  readonly inputMs: number
  /** How long the window's resizes are held at most, or until `settle`. */
  readonly sizeMs: number
  /**
   * Whether the keys held count as the person's only once delivered, as an answer's hold
   * may drop them (see `discard`).
   */
  readonly deferred?: boolean
}

/** The person's input to a terminal, held for one piece of work at the agent's input box. */
export type InputHold = {
  /** Lets the person's input go on, writing the keys it held; the resizes stay held. */
  readonly release: () => void
  /** Lets the window's resizes go on too, releasing the input if it is still held. */
  readonly settle: () => void
  /**
   * Lets the window's resizes go on in `ms`, after the work's last key: a `settle` before
   * then, by this hold or by the one that takes it over, waits until then instead of
   * applying them, as a resize as a turn starts may crash a TUI.
   */
  readonly settleAfter: (ms: number) => void
  /** Whether the input is still held. */
  readonly holding: () => boolean
  /** Drops what the person typed while their input was held. */
  readonly discard: () => void
}

/** A hold on a terminal that doesn't run: it holds nothing. */
export const noHold: InputHold = {
  release: () => {},
  settle: () => {},
  settleAfter: () => {},
  holding: () => false,
  discard: () => {},
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
  /** Keys that count as the person's, just before they are written (see `input`). */
  keys: (keys: string) => void
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
  /** The current run's exit, once handled; null while it runs. */
  readonly exit: Exit | null
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
  /** The screen's text, or what `read` takes of the screen, once the draws queued before it are on it. */
  readScreen(): Promise<ScreenText>
  readScreen<T>(read: (screen: Screen) => T): Promise<T>
  /** Draws `text` on the screen behind the draws queued before it, as a transcript restored. */
  replay(text: string, separator?: string): Promise<void>
  /**
   * Resizes the pty now, and the screen once the draws queued before are on it. While a
   * hold is in force, the latest size from `owner` waits until it settles.
   */
  resize(cols: number, rows: number, owner?: string): void
  /** When a resize last changed the size, in epoch milliseconds; 0 before any. */
  readonly resizedAt: number
  /** What the terminal reports to its program now: the mouse and focus a TUI asked for. */
  reporting(): Reporting
  /**
   * The controller's keys: written now, or, while a hold is in force, the terminal's own
   * reports now and the keys once it releases. Keys that count as the person's are told to
   * `keys` listeners first.
   */
  input(data: string): void
  /** The holder's own writes, as a ring's paste or an answer's keys: never held. */
  type(data: string): void
  /**
   * Holds the person's input for at most `budget.inputMs`, and the resizes until the hold
   * settles or `budget.sizeMs` passes. Never in force with another, apart from one that only
   * waits on its resizes, which this one takes over. A hold on a terminal that doesn't run, or
   * that its host let go, writes nothing and isn't `holding`.
   */
  hold(budget: HoldBudget): InputHold
  on<K extends keyof Listeners>(event: K, listener: Listeners[K]): Disposable
  /** Ends every attachment and all control, as the host stops. */
  end(): void
  /** Lets go of the current run's screen and listeners. */
  dispose(): void
}

/** A terminal as its host holds it: its draw chain and its restart in place, which the host runs. */
export type HostedTerminal = Terminal & {
  /** Runs `work` once everything queued before it has, draws included. */
  enqueue<T>(work: () => T | Promise<T>): Promise<T>
  /**
   * A new run in place, in an `enqueue` step: `spec` starts, the earlier run's screen and
   * listeners go, attachments end, the ring starts over with a sequence number skipped, so
   * an earlier cursor gets a snapshot, and `controller` controls it. `swapped` runs last, in
   * the same step. Only once the earlier run's exit is handled; a spawn that fails throws
   * `SPAWN_FAILED`, leaving the earlier run as it was.
   */
  restart(spec: RunSpec, controller: string | undefined, swapped: () => void): void
  /** Its host let it go: no hold holds it any more. */
  gone(): void
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

export const createTerminal = (options: TerminalOptions): HostedTerminal => {
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
    keys: new Set(),
  }
  const fire = <K extends keyof Listeners>(event: K, ...args: Parameters<Listeners[K]>) => {
    for (const listener of listeners[event]) (listener as (...all: typeof args) => void)(...args)
  }

  let size = { cols: options.spec.cols, rows: options.spec.rows }
  let resizedAt = 0
  let gone = false
  // The hold in force: the person's keys it holds (null once released), whether they count
  // only once delivered, when its resizes may apply at the earliest (epoch milliseconds,
  // taken over by the next hold), and the latest size it holds, with the attachment it came
  // from.
  let held: {
    input: string[] | null
    deferred?: boolean
    notBefore?: number
    size: { cols: number; rows: number; owner: string; attachment: Subscription | undefined } | null
  } | null = null
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

  const reporting = (): Reporting => {
    const { modes } = run.screen
    return {
      mouse: mouseReporting(modes.mouseTrackingMode, run.mouse()),
      focus: modes.sendFocusMode,
    }
  }

  // Whether a hold still holds: the terminal runs, and its host keeps it.
  const live = () => !gone && !exiting && exit === null

  const applySize = (cols: number, rows: number) => {
    // Only a new size redraws the screen, as a window attaching again may ask for the same.
    if (cols !== size.cols || rows !== size.rows) resizedAt = Date.now()
    run.pty.resize(cols, rows)
    void enqueue(() => {
      run.screen.resize(cols, rows)
      size = { cols, rows }
      fire("resized", { cols, rows })
      emit({ type: "resized", cols, rows })
    })
  }

  const hold = (budget: HoldBudget): InputHold => {
    if (!live() || held?.input) return noHold
    const mine: NonNullable<typeof held> = {
      input: [],
      size: held?.size ?? null,
      ...(held?.notBefore !== undefined && { notBefore: held.notBefore }),
      ...(budget.deferred && { deferred: true }),
    }
    held = mine
    let lapse: ReturnType<typeof setTimeout> | undefined
    const release = () => {
      clearTimeout(inputCap)
      const { input } = mine
      if (held !== mine || !input) return
      mine.input = null
      if (input.length === 0 || !live()) return
      if (mine.deferred) fire("keys", input.join(""))
      run.pty.write(input.join(""))
    }
    const settle = () => {
      release()
      if (held !== mine) return
      // Taken over from a hold whose last key was pressed lately: the resizes keep waiting
      // until it has lapsed, as one landing as a turn starts crashed Codex.
      const wait = (mine.notBefore ?? 0) - Date.now()
      if (wait > 0) {
        clearTimeout(lapse)
        lapse = setTimeout(settle, wait)
        lapse.unref()
        return
      }
      finish()
    }
    const finish = () => {
      release()
      clearTimeout(sizeCap)
      clearTimeout(lapse)
      if (held !== mine) return
      held = null
      if (!live()) return
      // Only for the attachment still in control: one that took over meanwhile, or the same
      // window attached anew, was told the size in force and asks its own.
      const { size: waiting } = mine
      if (
        !waiting ||
        controller !== waiting.owner ||
        subscribers.get(waiting.owner) !== waiting.attachment
      )
        return
      try {
        applySize(waiting.cols, waiting.rows)
      } catch {
        // A program that exited meanwhile takes no size; its exit is handled in turn.
      }
    }
    // A ring or a prompt takes well under these; should it not, the person's keys, then
    // the window's sizes, go on.
    const inputCap = setTimeout(release, budget.inputMs)
    inputCap.unref()
    // Past the input's own cap, as an answer's hold needs, the resizes stay held too.
    const sizeCap = setTimeout(finish, budget.sizeMs)
    sizeCap.unref()
    return {
      release,
      settle,
      settleAfter: (ms) => {
        mine.notBefore = Date.now() + ms
        settle()
      },
      holding: () => held === mine && mine.input !== null && live(),
      discard: () => {
        if (mine.input) mine.input.length = 0
      },
    }
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
    get exit() {
      return exit
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
    resize: (cols, rows, owner) => {
      // While a ring or an answer holds the terminal, a resize would redraw the screen it
      // checks, or land as its turn starts: the latest waits for the hold to settle.
      if (held && owner !== undefined) {
        held.size = { cols, rows, owner, attachment: subscribers.get(owner) }
        return
      }
      applySize(cols, rows)
    },
    get resizedAt() {
      return resizedAt
    },
    reporting,
    input: (data) => {
      // While a hold is in force, the person's keys wait their turn; the terminal's own
      // reports never do.
      const holding = held?.input ? held : undefined
      if (holding?.input) {
        // An answer's hold drops the mouse's wheel and motion reports, never replaying them.
        const { reports, typed } = splitReports(data, reporting(), holding.deferred === true)
        if (reports) run.pty.write(reports)
        if (typed) {
          // An answer's hold may drop them: they count once they are delivered.
          if (!holding.deferred) fire("keys", typed)
          holding.input.push(typed)
        }
        return
      }
      fire("keys", data)
      // node-pty takes each write synchronously; no input is retried after an uncertain delivery.
      run.pty.write(data)
    },
    type: (data) => run.pty.write(data),
    readScreen: (<T>(read?: (screen: Screen) => T) =>
      enqueue(() => (read ? read(run.screen) : readScreen(run.screen)))) as Terminal["readScreen"],
    replay: (text, separator) => {
      const { screen } = run
      return enqueue(() => replayOn(screen, text, separator))
    },
    gone: () => {
      gone = true
    },
    hold,
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
      held = null
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
