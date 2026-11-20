// What only the window the person used last (the voice) does, so two windows never double up:
// raising notifications and counting on the app's icon. Pure over the window type and the
// effects it is given; the main process hands it Electron's.
import type { DesktopBadge } from "@novadeck/protocol/bridge"

const noBadge: DesktopBadge = { count: 0, image: null }

export const createVoice = <Window>(host: {
  readonly hasVoice: (window: Window) => boolean
  /** Shows the badge on the app's icon, for this window where the platform keeps one for each. */
  readonly applyBadge: (window: Window, badge: DesktopBadge) => void
  /** Takes away every notification the app is showing. */
  readonly closeNotices: () => void
  readonly alive: (window: Window) => boolean
}) => {
  // Each window's last count, for the window that takes the voice to show.
  const counts = new Map<Window, DesktopBadge>()
  return {
    /** Whether a window's notice may be raised: only the voice's. */
    mayRaise: (window: Window): boolean => host.hasVoice(window),
    /** A page reports its Inbox count: kept, and shown only while its window has the voice. */
    counted: (window: Window, badge: DesktopBadge): void => {
      counts.set(window, badge)
      if (host.hasVoice(window)) host.applyBadge(window, badge)
    },
    /** The voice moved from one window to another: the first's count goes, the second's shows. */
    moved: (from: Window | undefined, to: Window | undefined): void => {
      if (from !== undefined) host.applyBadge(from, noBadge)
      if (to !== undefined && host.alive(to)) host.applyBadge(to, counts.get(to) ?? noBadge)
    },
    /**
     * A window closed, `wasVoice` as it was when it did and `remaining` windows left: what a
     * closed voice raised goes with it, however its window's destruction is reported, and
     * with no window left no count stays.
     */
    closed: (window: Window, wasVoice: boolean, remaining: number): void => {
      counts.delete(window)
      if (wasVoice || remaining === 0) host.closeNotices()
      if (remaining === 0) host.applyBadge(window, noBadge)
    },
    /** A window's page went away or loaded again: what it showed goes, if it had the voice. */
    reset: (window: Window): void => {
      counts.delete(window)
      if (!host.hasVoice(window)) return
      host.closeNotices()
      host.applyBadge(window, noBadge)
    },
  }
}

/** How long a notification's click waits for the page to bring a window forward. */
export const noticeClickWaitMs = 400

/**
 * What a click on a notification does. Without project windows the window that raised it
 * comes forward and its page is told. With them the page hands the click to the window of the
 * project it is about, which comes forward; should none have by `noticeClickWaitMs`, as when
 * the terminal is gone or the page and the app disagree about the switch, the raising window
 * comes forward, or the voice's if it went away. Nothing when no window is left.
 */
export const clickNotice = <Window>({
  windowsOn,
  raising,
  voice,
  alive,
  send,
  forward,
  forwards,
  later,
}: {
  readonly windowsOn: boolean
  readonly raising: Window
  readonly voice: Window | undefined
  readonly alive: (window: Window) => boolean
  /** Tells the window's page of the click. */
  readonly send: (window: Window) => void
  readonly forward: (window: Window) => void
  /** How many windows have been brought forward so far. */
  readonly forwards: () => number
  readonly later: (run: () => void, ms: number) => void
}): void => {
  const target = alive(raising) ? raising : voice !== undefined && alive(voice) ? voice : undefined
  if (target === undefined) return
  if (!windowsOn) {
    forward(target)
    send(target)
    return
  }
  const before = forwards()
  send(target)
  later(() => {
    if (forwards() === before && alive(target)) forward(target)
  }, noticeClickWaitMs)
}

/**
 * The windows to keep for the next launch: those open and showing a project while the app is
 * not quitting, none (nothing to change) once a quit is under way, whose closes are no one
 * leaving a window, or when none is left, as when the last window closed.
 */
export const windowsToKeep = <Kept>(open: readonly Kept[], stopping: boolean): Kept[] | undefined =>
  stopping || open.length === 0 ? undefined : [...open]
