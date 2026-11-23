import type { AttachStream, Exit, TerminalEvent } from "../contract.js"
import { classifyInput, takeIdleMs } from "./takeover.js"
import type { ControlStrip, Store, ViewLink } from "./view-state.js"

// A terminal's shell as following it needs to know it: when it is ready to attach to, when
// a fresh one replaces it, and whether it is gone. The fields are read as they stand, so an
// owner may hand over the live record.
export type Lifecycle = {
  // Resolves once a shell runs, with whether one does.
  readonly ready: Promise<boolean>
  // Resolves once a fresh shell replaces an ended one.
  readonly revived: Promise<void>
  readonly closed: boolean
  // The size a fresh shell starts with.
  readonly size: { readonly cols: number; readonly rows: number }
}

// What the view tells its owner as it goes.
export type ViewEvents<K> = {
  // The stream saw the shell exit, in order with its output.
  readonly exited?: (key: K, exit: Exit) => void
  // The size that fit.
  readonly resized?: (key: K, size: { readonly cols: number; readonly rows: number }) => void
  // The screen's stage: mounted, first screen drawn, or gone.
  readonly stage?: (key: K, stage: "mounted" | "shown" | "gone") => void
  // Why the terminal could not be followed.
  readonly lost?: (key: K, error: unknown) => void
  // An attach has been refused as busy for `busyToldMs` and goes on being asked for, quietly:
  // the owner may say so where the person looks, once for each wait. `error` is the refusal.
  readonly waiting?: (key: K, error: unknown) => void
  // The stream, until the returned release; the owner may note it.
  readonly attached?: (key: K, stream: AttachStream) => () => void
}

// What following a terminal asks of its owner.
export type FollowOptions<K> = {
  readonly attach: (key: K) => Promise<AttachStream>
  readonly lifecycle: (key: K) => Lifecycle | undefined
  // How the link is doing; a stream takes up again when it comes back.
  readonly connection: Store<ViewLink>
  // Resolves once the link is reachable again, or closed for good.
  readonly reconnected: () => Promise<void>
  // How an attach that failed should go on: try again shortly while busy, wait for the link
  // while offline, give up and tell of it otherwise.
  readonly classify: (error: unknown) => "busy" | "offline" | "fatal"
  // Whether a shell that exited like this waits for Enter to start again.
  readonly waitsAfter: (exit: Exit) => boolean
  // Counts the promise as outstanding I/O until it settles.
  readonly track?: <T>(work: Promise<T>) => Promise<T>
  readonly on?: ViewEvents<K>
}

// The screen a terminal draws on, reduced to what following it needs.
export type Screen = {
  // Rejects when the emulator could not draw it, which leaves the screen in doubt.
  readonly write: (data: string) => Promise<void>
  readonly reset: () => void
  readonly resize: (size: { readonly cols: number; readonly rows: number }) => void
  // The size that fits the element now; undefined while it has no room, as when hidden.
  readonly fit: () => { readonly cols: number; readonly rows: number } | undefined
  // Called in stream order once the shell has exited, after its last output is drawn,
  // with whether it waits for Enter to start again.
  readonly exited: (waiting: boolean) => void
  // Whether a stream is drawing the current shell: true once its screen arrived, false
  // once a park let go of the stream or it ended, or while it takes up again after a
  // reconnection (`resuming`). Input goes nowhere in between.
  readonly live: (live: boolean, resuming?: boolean) => void
  // How long the screen gathers output before drawing it, in ms; 0 or absent draws each as
  // it comes. Output that arrives meanwhile is drawn in one write, and anything else the
  // stream sends ends the wait, so every event still applies in order after what came first.
  readonly pace?: () => number
  // Resolves once the pace changes, which ends a wait at once, as when the terminal is
  // selected.
  readonly paced?: () => Promise<void>
  // Called once the host's snapshot of the screen is drawn, which is the whole screen and
  // scrollback again: on opening, and on every reattach.
  readonly restored?: () => void
  // While this client only observes the terminal: the screen draws at the pty's size, scaled
  // down to fit its frame and anchored top left, and is not fitted to it. `null` is the
  // frame's fit again, as when this client controls.
  readonly observe?: (size: { readonly cols: number; readonly rows: number } | null) => void
  // What the person is told of who has the keyboard while observing; `null` says nothing.
  readonly strip?: (strip: ControlStrip | null) => void
  // This client took control with a key that was not delivered: say that it has the keyboard.
  readonly took?: () => void
}

// The most output a paced screen gathers before drawing it: a flood draws in steps, and what
// waits stays small.
const gatherCap = 256 * 1024

export type FollowedTerminal = {
  // Sends typed input; dropped while there is no attachment.
  readonly input: (data: string) => void
  // Tells the owner the size that fits now, and the stream if it changed. Whether it sent
  // the stream a size it had not sent before. While the stream only observes, it sends
  // nothing and draws the pty's size scaled into the frame instead.
  readonly refit: () => boolean
  // Asks for control, as the person's button does (no idle limit unless `ifIdleMs` says). Resolves
  // at once unless the stream observes, and once control is here; rejects with the host's refusal,
  // which the strip then shows as busy.
  readonly take: (options?: { readonly ifIdleMs?: number }) => Promise<void>
  // Lets go of the stream while no view shows the terminal, so its output costs nothing
  // here while the screen keeps what it last drew; `unpark` attaches again, and the
  // host's fresh screen brings it up to date. A fresh shell started meanwhile waits
  // for it too.
  readonly park: () => void
  readonly unpark: () => void
  readonly stop: () => void
}

// Resolves after `ms` milliseconds.
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// How long a screen that failed to draw waits before it attaches again: the first, doubling
// with each failure in a row up to the most. A failure `apart` after the one before it is the
// first again. One that fails on every snapshot, or soon after each, settles at a redraw every
// `most`: short, as the screen shows "Loading output…" meanwhile, and a snapshot costs little.
// How long an attach refused as busy is asked for before the owner is told it waits.
export const busyToldMs = 4_000

// How long a client that just became the controller waits for its frame to settle (the strip
// unmounting resizes it, which fits again after the screens' own settle of 120 ms).
const becomingMs = 200

const redrawMs = { first: 250, most: 5_000, apart: 60_000 }

// Attaches to the terminal, draws what it sends, and passes input and size back until
// stopped. When its shell exits, or the host loses it, the view waits for a fresh
// shell and attaches again. A terminal another window controls is reported instead. A
// screen that failed to draw lets go of the stream and attaches again, for a fresh screen
// from the host: the shell is fine, only what this screen shows is in doubt.
export const followTerminal = <K>(
  options: FollowOptions<K>,
  key: K,
  screen: Screen,
): FollowedTerminal => {
  const { on, lifecycle, connection } = options
  const track = options.track ?? (<T>(work: Promise<T>): Promise<T> => work)
  let stopped = false
  let stop: (() => void) | undefined
  const halted = new Promise<void>((resolve) => {
    stop = resolve
  })
  let attachment: AttachStream | undefined
  // The wait before a new controller fits its frame.
  let becoming: ReturnType<typeof setTimeout> | undefined
  let sent: string | undefined
  // Resolves once the stream may attach, as it may unless parked.
  let unparked: Promise<void> | undefined
  let wake: (() => void) | undefined
  // A park ended the stream: the same shell runs on, so it attaches again, even when
  // shown before the stream wound down.
  let cut = false
  // The failures to draw in a row, and when the last was.
  let failures = 0
  let failedAt = 0
  // The pty's size, as the host last said it, which an observing screen draws at.
  let ptySize: { readonly cols: number; readonly rows: number } | undefined
  // A take was refused, and the strip says so, until the mode changes or a take lands.
  let busy = false
  const observing = (): boolean => attachment?.mode === "observe"
  // Draws at the pty's size; an observer scales it into the frame.
  const drawAt = (size: { readonly cols: number; readonly rows: number }): void => {
    screen.resize(size)
    if (observing()) screen.observe?.(size)
  }
  const refit = (): boolean => {
    if (observing()) {
      // The frame never decides the size of a terminal this client doesn't control.
      if (ptySize) drawAt(ptySize)
      return false
    }
    const size = screen.fit()
    if (size) on?.resized?.(key, size)
    if (!size || !attachment) return false
    screen.resize(size)
    const next = `${size.cols}x${size.rows}`
    if (next === sent) return false
    sent = next
    const attached = attachment
    void attached.resize(size.cols, size.rows).catch(() => {
      sent = undefined
      // Busy or reconnecting: try again while this stream lasts.
      setTimeout(() => {
        if (attachment === attached) refit()
      }, 500)
    })
    return true
  }
  const apply = async (event: TerminalEvent): Promise<void> => {
    if (event.type === "snapshot") {
      screen.reset()
      ptySize = { cols: event.cols, rows: event.rows }
      drawAt(ptySize)
      sent = `${event.cols}x${event.rows}`
      await screen.write(event.data)
      screen.restored?.()
      // A park that came while it drew has let go of this stream already.
      if (!unparked) screen.live(true)
      on?.stage?.(key, "shown")
      if (event.exit) {
        on?.exited?.(key, event.exit)
        screen.exited(options.waitsAfter(event.exit))
      }
      refit()
    } else if (event.type === "output") await screen.write(event.data)
    else if (event.type === "exited") {
      on?.exited?.(key, event.exit)
      screen.exited(options.waitsAfter(event.exit))
    } else if (event.type === "resized") {
      sent = `${event.cols}x${event.rows}`
      ptySize = { cols: event.cols, rows: event.rows }
      drawAt(ptySize)
    }
  }
  const wanted = (entry: Lifecycle): boolean => !stopped && !unparked && !entry.closed
  // Attaches, retrying after the host comes back; undefined when it cannot, or once
  // parked, which marks the stream cut.
  const open = async (entry: Lifecycle): Promise<AttachStream | undefined> => {
    let busySince: number | undefined
    let told = false
    while (wanted(entry)) {
      try {
        // eslint-disable-next-line no-await-in-loop -- Retry after the host comes back.
        const attached = await options.attach(key)
        if (wanted(entry)) return attached
        cut ||= Boolean(unparked)
        // Release before giving up.
        attached.close()
        return undefined
      } catch (error) {
        const failure = options.classify(error)
        if (failure === "busy") {
          busySince ??= Date.now()
          if (!told && Date.now() - busySince >= busyToldMs) {
            told = true
            on?.waiting?.(key, error)
          }
          // Too many calls in flight: try again shortly.
          // eslint-disable-next-line no-await-in-loop -- Back off before trying again.
          await Promise.race([pause(300), halted])
          continue
        }
        if (failure !== "offline") {
          on?.lost?.(key, error)
          return undefined
        }
        // eslint-disable-next-line no-await-in-loop -- Wait for the host to come back.
        await Promise.race([options.reconnected(), halted])
      }
    }
    cut ||= Boolean(unparked)
    return undefined
  }
  // Follows the stream until it ends; whether the screen failed to draw it.
  const follow = async (attached: AttachStream): Promise<boolean> => {
    attachment = attached
    ptySize = undefined
    busy = false
    // The stream's mode is live: control passes between clients while it is followed.
    const syncMode = (): void => {
      if (attachment !== attached) return
      clearTimeout(becoming)
      if (attached.mode === "observe") {
        screen.strip?.(busy ? "busy" : "observing")
        if (ptySize) drawAt(ptySize)
        return
      }
      screen.strip?.(null)
      screen.observe?.(null)
      // The new controller fits the frame and says so, whatever size it last sent: once the
      // strip is gone from it and the frame has settled, not while the strip still takes its
      // room, which would send a size and then another. The frame's own resize, when it comes
      // first, sends the same size, so this one finds nothing more to send.
      sent = undefined
      becoming = setTimeout(() => {
        if (attachment === attached && attached.mode === "control") refit()
      }, becomingMs)
    }
    const unwatchMode = attached.onMode?.(() => {
      busy = false
      syncMode()
    })
    if (attached.mode === "observe") screen.strip?.("observing")
    const release = on?.attached?.(key, attached)
    let failed = false
    try {
      // Read by hand, so a paced screen can look ahead for output to draw with what it has.
      const events = attached[Symbol.asyncIterator]()
      let ahead: Promise<IteratorResult<TerminalEvent>> | undefined
      const pull = (): Promise<IteratorResult<TerminalEvent>> => (ahead ??= events.next())
      // The events to apply next, from `first`: on a paced screen, its output with what
      // follows it within the pace, up to the first event of another kind, which comes after.
      const gather = async (
        first: TerminalEvent,
      ): Promise<{ readonly batch: readonly TerminalEvent[]; readonly ended: boolean }> => {
        const ms = screen.pace?.() ?? 0
        if (first.type !== "output" || !ms) return { batch: [first], ended: false }
        let output = first
        const deadline = Date.now() + ms
        const changed = screen.paced?.() ?? new Promise<void>(() => {})
        while (output.data.length < gatherCap) {
          let timer: ReturnType<typeof setTimeout> | undefined
          const waited = new Promise<"waited">((resolve) => {
            timer = setTimeout(() => resolve("waited"), Math.max(0, deadline - Date.now()))
          })
          try {
            // eslint-disable-next-line no-await-in-loop -- One event after another, until the pace is up.
            const next = await Promise.race([
              pull(),
              waited,
              changed.then(() => "waited" as const),
              halted.then(() => "waited" as const),
            ])
            if (next === "waited") break
            ahead = undefined
            if (next.done) return { batch: [output], ended: true }
            if (next.value.type !== "output") return { batch: [output, next.value], ended: false }
            output = { ...next.value, data: output.data + next.value.data }
          } finally {
            clearTimeout(timer)
          }
        }
        return { batch: [output], ended: false }
      }
      let ended = false
      try {
        // `stopped` changes through `stop`, out of the loop's sight.
        const going = (): boolean => !stopped && !ended && !failed
        while (going()) {
          // eslint-disable-next-line no-await-in-loop -- Drawing paces acknowledgement.
          const read = await pull()
          ahead = undefined
          if (read.done) break
          // eslint-disable-next-line no-await-in-loop -- As above.
          const gathered = await gather(read.value)
          ended = gathered.ended
          for (const event of gathered.batch) {
            if (stopped) break
            try {
              // eslint-disable-next-line no-await-in-loop -- Drawing paces acknowledgement.
              await apply(event)
            } catch {
              // The screen is in doubt; the emulator threw the error again, for the page's log.
              failed = !stopped
              break
            }
          }
        }
      } finally {
        // As a for-await loop left early does: the stream is told it is no longer read.
        if (!ended) void events.return?.()
      }
    } catch (error) {
      if (!stopped) on?.lost?.(key, error)
    } finally {
      release?.()
      unwatchMode?.()
      clearTimeout(becoming)
      attachment = undefined
      screen.strip?.(null)
      screen.observe?.(null)
      screen.live(false)
    }
    if (failed) attached.close()
    return failed
  }
  // A function, as the loop's condition changes through `stop`, out of its sight.
  const running = (): boolean => !stopped
  const run = async (): Promise<void> => {
    while (running()) {
      const entry = lifecycle(key)
      if (!entry || entry.closed) return
      // eslint-disable-next-line no-await-in-loop -- Parked, it attaches once shown again.
      if (unparked) await Promise.race([unparked, halted])
      // Taken before attaching, so a fresh shell started meanwhile is not missed; and after
      // a park, so one started while parked, which it attaches to, doesn't count again.
      const { revived } = entry
      // eslint-disable-next-line no-await-in-loop -- The shell must exist first.
      const ready = await Promise.race([entry.ready, halted])
      // Parked while it started: it attaches once shown.
      if (unparked) continue
      // eslint-disable-next-line no-await-in-loop -- Then attach to it.
      const attached = ready && (await track(open(entry)))
      // eslint-disable-next-line no-await-in-loop -- One attachment at a time.
      const failed = attached && (await follow(attached))
      if (cut || unparked) {
        cut = false
        continue
      }
      if (failed) {
        const now = Date.now()
        failures = now - failedAt >= redrawMs.apart ? 1 : failures + 1
        failedAt = now
        const wait = Math.min(redrawMs.first * 2 ** (failures - 1), redrawMs.most)
        // eslint-disable-next-line no-await-in-loop -- Back off before drawing again.
        await Promise.race([pause(wait), halted])
        continue
      }
      // eslint-disable-next-line no-await-in-loop -- Wait for a fresh shell.
      await Promise.race([revived, halted])
    }
  }
  void run()
  // After a reconnection the attachment takes up again on its own, without a new screen.
  // Until a call through it succeeds, input would be lost, so the view stays locked;
  // re-sending the current size is a harmless call to find out.
  let resumes = 0
  const resume = async (attached: AttachStream): Promise<void> => {
    const turn = (resumes += 1)
    screen.live(false, true)
    const current = (): boolean =>
      !stopped && !unparked && attachment === attached && turn === resumes
    while (current()) {
      // An observer can't send a size: its stream is as live as its events say.
      if (attached.mode === "observe") {
        screen.live(true)
        return
      }
      const size = lifecycle(key)?.size ?? screen.fit()
      try {
        // eslint-disable-next-line no-await-in-loop -- One probe at a time.
        if (size) await attached.resize(size.cols, size.rows)
        if (current()) screen.live(true)
        return
      } catch {
        // eslint-disable-next-line no-await-in-loop -- Still reattaching; look again soon.
        await Promise.race([pause(200), halted])
      }
    }
  }
  let previous = connection.getSnapshot()
  const unsubscribe = connection.subscribe(() => {
    const state = connection.getSnapshot()
    const back = previous !== "connected" && state === "connected"
    previous = state
    if (back && attachment) void resume(attachment)
  })
  // Input that asks for the keyboard waits its turn, and so does whatever is typed while any of it
  // is still waiting, even after control has come, so what is typed lands in order.
  let queue: Promise<void> = Promise.resolve()
  let waiting = 0
  const enqueue = (stream: AttachStream, data: string): void => {
    const kind = classifyInput(data)
    // The emulator's own reports go to a controller alone.
    if (kind === "report" && stream.mode === "observe") return
    waiting += 1
    queue = queue.then(async () => {
      try {
        if (attachment !== stream) return
        let took = false
        if (stream.mode === "observe") {
          if (kind === "report") return
          try {
            await stream.take?.({ ifIdleMs: takeIdleMs })
          } catch {
            // The controller is typing, or can't be told: nothing is delivered.
            busy = true
            if (attachment === stream) screen.strip?.("busy")
            return
          }
          // The mode changes as the take lands, out of this function's sight.
          if ((stream.mode as string) !== "control") return
          took = true
        }
        // A key that took control is not delivered; the next one goes through.
        if (took && kind === "key") return screen.took?.()
        await stream.write(data).catch(() => {})
      } finally {
        waiting -= 1
      }
    })
  }
  return {
    input: (data) => {
      const entry = lifecycle(key)
      if (!attachment || !entry || entry.closed) return
      if (attachment.mode === "observe" || waiting > 0) return enqueue(attachment, data)
      void attachment.write(data).catch(() => {})
    },
    take: async (asked) => {
      const stream = attachment
      if (stream?.mode !== "observe") return
      try {
        if (!stream.take) throw new Error("The host can't hand control over.")
        await stream.take(asked)
      } catch (error) {
        busy = true
        if (attachment === stream) screen.strip?.("busy")
        throw error
      }
    },
    refit,
    park: () => {
      if (stopped || unparked) return
      unparked = new Promise((resolve) => {
        wake = resolve
      })
      if (!attachment) return
      cut = true
      // Nothing draws it from now on, though the stream ends a moment later.
      screen.live(false)
      attachment.close()
    },
    unpark: () => {
      if (!unparked) return
      unparked = undefined
      wake?.()
    },
    stop: () => {
      unsubscribe()
      clearTimeout(becoming)
      stopped = true
      stop?.()
      const attached = attachment
      attachment = undefined
      attached?.close()
    },
  }
}
