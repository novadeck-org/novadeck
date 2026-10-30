import "./terminal-xterm.css"
import type { MountTerminal, TerminalKey, TerminalMountProps, ViewState } from "@novadeck/core/port"
import type { ViewMode } from "@novadeck/core/types"
import type { Hold, TerminalViews, ViewPhase } from "@novadeck/terminal/view"

// The shell's stage for a terminal's status: an exited or failed one waits for Enter.
const phaseOf = (status: TerminalMountProps["status"]): ViewPhase =>
  status === "exited" || status === "failed"
    ? "ended"
    : status === "starting"
      ? "starting"
      : "running"

// Whether a view's screens draw with WebGL. Canvas zooms its windows with a CSS transform,
// which the DOM renderer's text is drawn again at but WebGL's canvas is stretched by, soft
// above one and ragged below, so Canvas keeps the DOM renderer.
const wantsWebgl = (view: ViewMode): boolean => view !== "canvas"

// The views a mount takes its screen from: only `acquire` is the mount's.
type Screens = Pick<TerminalViews<TerminalKey>, "acquire">

// What a mount asks of its screen: the input's accessible name in the app's words, the
// shell's stage, and whether the view draws with WebGL.
type ShowOptions = Parameters<Screens["acquire"]>[1]
const showOptions = (props: TerminalMountProps): ShowOptions => ({
  label: `Input for ${props.name}`,
  phase: phaseOf(props.status),
  webgl: wantsWebgl(props.view),
})

// What every backend's screens are drawn in: the one input the port asks for, and the
// container this folder's styles reach (terminal-xterm.css).
export const screenMarkup = {
  input: { "data-terminal-input": "" },
  containerClass: "terminal-xterm min-h-0 flex-1",
} as const

// What the UI sees of a mount before it has a screen, or while it lets its screen go.
const opening: ViewState = { live: false, resuming: false, waits: false, lock: null, notice: null }

// Draws terminals into the elements the UI gives them: each mount holds its terminal's
// screen while it is on screen, and places it in its element. The screens outlive the
// mounts: a view switch disposes one mount and creates the next, which takes the same
// emulator and attachment instead of opening them again.
export const createTerminalMount =
  (screens: Screens): MountTerminal =>
  (element, key, initial) => {
    let props = initial
    let hold: Hold | undefined
    let disposed = false
    // What the UI sees while no screen is held: the last state the screen had.
    let last: ViewState = opening
    const listeners = new Set<() => void>()
    let unwatch: (() => void) | undefined

    // A store the UI holds for the mount's life, forwarding the held screen's: a screen the
    // parked-screen cap closed while the mount was away reopens with a store of its own.
    // Forwarding adds no store, so each change of state still wakes one listener.
    const snapshot = (): ViewState => hold?.state.getSnapshot() ?? last
    const notify = (): void => listeners.forEach((listener) => listener())
    const holdScreen = (next: Hold | undefined): void => {
      const before = snapshot()
      if (hold) last = hold.state.getSnapshot()
      unwatch?.()
      unwatch = undefined
      hold = next
      unwatch = next?.state.subscribe(notify)
      if (snapshot() !== before) notify()
    }

    // Takes the screen and places it, again after every acquire: one the cap closed opens in a
    // new container.
    const acquire = (): void => {
      const acquired = screens.acquire(key, showOptions(props))
      holdScreen(acquired)
      acquired.place(element)
    }
    if (props.onScreen !== false) acquire()

    return {
      state: {
        getSnapshot: snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => void listeners.delete(listener)
        },
      },
      update: (next) => {
        const before = props
        props = next
        if (disposed) return
        const was = before.onScreen !== false
        const is = next.onScreen !== false
        if (was && !is) {
          // Out of sight, the mount stays and shows the element's last drawing. Focus it held
          // is not left for a next mount: this is not an unmount.
          const released = hold
          holdScreen(undefined)
          released?.release()
        } else if (!was && is) acquire()
        else hold?.update(showOptions(next))
      },
      focus: () => hold?.focus() ?? false,
      restart: () => hold?.restart(),
      dispose: () => {
        if (disposed) return
        disposed = true
        const released = hold
        // The screen's last state stays for whatever still reads it.
        holdScreen(undefined)
        released?.release({ unmount: true })
      },
    }
  }
