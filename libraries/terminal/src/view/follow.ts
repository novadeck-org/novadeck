import type { AttachStream, Exit, TerminalEvent } from "../contract.js"
import { pause } from "./pause.js"
import type { Store, ViewLink } from "./view-state.js"

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
}

export type FollowedTerminal = {
  // Sends typed input; dropped while there is no attachment.
  readonly input: (data: string) => void
  // Tells the owner the size that fits now, and the stream if it changed. Whether it sent
  // the stream a size it had not sent before.
  readonly refit: () => boolean
  // Lets go of the stream while no view shows the terminal, so its output costs nothing
  // here while the screen keeps what it last drew; `unpark` attaches again, and the
  // host's fresh screen brings it up to date. A fresh shell started meanwhile waits
  // for it too.
  readonly park: () => void
  readonly unpark: () => void
  readonly stop: () => void
}

// How long a screen that failed to draw waits before it attaches again: the first, doubling
// with each failure in a row up to the most. A failure `apart` after the one before it is the
// first again, so one that fails on every snapshot, or on every output after one, settles at
// a redraw every `most`.
const redrawMs = { first: 250, most: 30_000, apart: 60_000 }

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
  const refit = (): boolean => {
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
      screen.resize(event)
      sent = `${event.cols}x${event.rows}`
      await screen.write(event.data)
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
      screen.resize(event)
    }
  }
  const wanted = (entry: Lifecycle): boolean => !stopped && !unparked && !entry.closed
  // Attaches, retrying after the host comes back; undefined when it cannot, or once
  // parked, which marks the stream cut.
  const open = async (entry: Lifecycle): Promise<AttachStream | undefined> => {
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
    const release = on?.attached?.(key, attached)
    let failed = false
    try {
      for await (const event of attached) {
        if (stopped) break
        try {
          // eslint-disable-next-line no-await-in-loop -- Drawing paces acknowledgement.
          await apply(event)
        } catch {
          // The screen is in doubt; the emulator logged why.
          failed = !stopped
          break
        }
      }
    } catch (error) {
      if (!stopped) on?.lost?.(key, error)
    } finally {
      release?.()
      attachment = undefined
      screen.live(false)
    }
    if (failed) attached.close()
    return failed
  }
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
  return {
    input: (data) => {
      const entry = lifecycle(key)
      if (!attachment || !entry || entry.closed) return
      void attachment.write(data).catch(() => {})
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
      stopped = true
      stop?.()
      const attached = attachment
      attachment = undefined
      attached?.close()
    },
  }
}
