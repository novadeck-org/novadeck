import type { TerminalEvent, TerminalExit } from "@novadeck/protocol"
import { hasCode, type AttachedTerminal } from "@novadeck/protocol/client"

import type { TerminalKey } from "../port"
import { exitStatus, restartable } from "./activity"
import type { SurfaceRuntime } from "./backend"
import { pause } from "./pause"

type FollowedEntry = NonNullable<ReturnType<SurfaceRuntime["entry"]>>

// The screen a runner terminal draws on, reduced to what following it needs.
export type Screen = {
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
  // Tells the runner the size that fits now, if it changed.
  readonly refit: () => void
  // Lets go of the stream while no view shows the terminal, so its output costs nothing
  // here while the screen keeps what it last drew; `unpark` attaches again, and the
  // runner's fresh screen brings it up to date. A fresh shell started meanwhile waits
  // for it too.
  readonly park: () => void
  readonly unpark: () => void
  readonly stop: () => void
}

// Attaches to the terminal, draws what it sends, and passes input and size back until
// stopped. When its shell exits, or the runner loses it, the surface waits for a fresh
// shell and attaches again. A terminal another window controls is reported instead.
export const followTerminal = (
  runtime: SurfaceRuntime,
  key: TerminalKey,
  screen: Screen,
): FollowedTerminal => {
  let stopped = false
  let stop: (() => void) | undefined
  const halted = new Promise<void>((resolve) => {
    stop = resolve
  })
  let attachment: AttachedTerminal | undefined
  let sent: string | undefined
  // Resolves once the stream may attach, as it may unless parked.
  let unparked: Promise<void> | undefined
  let wake: (() => void) | undefined
  // A park ended the stream: the same shell runs on, so it attaches again, even when
  // shown before the stream wound down.
  let cut = false
  const refit = (): void => {
    const size = screen.fit()
    if (size) runtime.resized(key, size)
    if (!size || !attachment) return
    screen.resize(size)
    const next = `${size.cols}x${size.rows}`
    if (next === sent) return
    sent = next
    const attached = attachment
    void attached.resize(size).catch(() => {
      sent = undefined
      // Busy or reconnecting: try again while this stream lasts.
      setTimeout(() => {
        if (attachment === attached) refit()
      }, 500)
    })
  }
  const apply = async (event: TerminalEvent): Promise<void> => {
    if (event.type === "snapshot") {
      screen.reset()
      screen.resize(event)
      sent = `${event.cols}x${event.rows}`
      await screen.write(event.data)
      // A park that came while it drew has let go of this stream already.
      if (!unparked) screen.live(true)
      runtime.screen(key, "shown")
      if (event.exit) {
        runtime.exited(key, event.exit)
        screen.exited(waitsForEnter(event.exit))
      }
      refit()
    } else if (event.type === "output") await screen.write(event.data)
    else if (event.type === "exited") {
      runtime.exited(key, event.exit)
      screen.exited(waitsForEnter(event.exit))
    } else if (event.type === "resized") {
      sent = `${event.cols}x${event.rows}`
      screen.resize(event)
    }
  }
  const wanted = (entry: FollowedEntry): boolean => !stopped && !unparked && !entry.closed
  // Attaches, retrying after the runner comes back; undefined when it cannot, or once
  // parked, which marks the stream cut.
  const open = async (entry: FollowedEntry): Promise<AttachedTerminal | undefined> => {
    while (wanted(entry)) {
      try {
        // eslint-disable-next-line no-await-in-loop -- Retry after the runner comes back.
        const attached = await runtime.attach(key.terminalId)
        if (wanted(entry)) return attached
        cut ||= Boolean(unparked)
        // eslint-disable-next-line no-await-in-loop -- Release before giving up.
        await attached.detach()
        return undefined
      } catch (error) {
        if (hasCode(error, "RESOURCE_LIMIT")) {
          // Too many calls in flight: try again shortly.
          // eslint-disable-next-line no-await-in-loop -- Back off before trying again.
          await Promise.race([pause(300), halted])
          continue
        }
        if (!hasCode(error, "DISCONNECTED")) {
          runtime.lost(key, error)
          return undefined
        }
        // eslint-disable-next-line no-await-in-loop -- Wait for the runner to come back.
        await Promise.race([runtime.connected(), halted])
      }
    }
    cut ||= Boolean(unparked)
    return undefined
  }
  const follow = async (attached: AttachedTerminal): Promise<void> => {
    attachment = attached
    const release = runtime.attached(key, attached)
    try {
      for await (const event of attached) {
        if (stopped) break
        // eslint-disable-next-line no-await-in-loop -- Drawing paces acknowledgement.
        await apply(event)
      }
    } catch (error) {
      if (!stopped) runtime.lost(key, error)
    } finally {
      release()
      attachment = undefined
      screen.live(false)
    }
  }
  const running = (): boolean => !stopped
  const run = async (): Promise<void> => {
    while (running()) {
      const entry = runtime.entry(key)
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
      const attached = ready && (await runtime.track(open(entry)))
      // eslint-disable-next-line no-await-in-loop -- One attachment at a time.
      if (attached) await follow(attached)
      if (cut || unparked) {
        cut = false
        continue
      }
      // eslint-disable-next-line no-await-in-loop -- Wait for a fresh shell.
      await Promise.race([revived, halted])
    }
  }
  void run()
  // After a reconnection the attachment takes up again on its own, without a new screen.
  // Until a call through it succeeds, input would be lost, so the surface stays locked;
  // re-sending the current size is a harmless call to find out.
  let resumes = 0
  const resume = async (attached: AttachedTerminal): Promise<void> => {
    const turn = (resumes += 1)
    screen.live(false, true)
    const current = (): boolean =>
      !stopped && !unparked && attachment === attached && turn === resumes
    while (current()) {
      const size = runtime.entry(key)?.size ?? screen.fit()
      try {
        // eslint-disable-next-line no-await-in-loop -- One probe at a time.
        if (size) await attached.resize(size)
        if (current()) screen.live(true)
        return
      } catch {
        // eslint-disable-next-line no-await-in-loop -- Still reattaching; look again soon.
        await Promise.race([pause(200), halted])
      }
    }
  }
  let previous = runtime.connection.getSnapshot()
  const unsubscribe = runtime.connection.subscribe(() => {
    const state = runtime.connection.getSnapshot()
    const back = previous !== "connected" && state === "connected"
    previous = state
    if (back && attachment) void resume(attachment)
  })
  return {
    input: (data) => {
      const entry = runtime.entry(key)
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
      void attachment.detach()
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
      void attached?.detach()
    },
  }
}

const waitsForEnter = (exit: TerminalExit): boolean => {
  const status = exitStatus(exit)
  return status !== "clean" && restartable(status)
}
