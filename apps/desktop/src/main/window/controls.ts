// The window's own controls on macOS, the close, minimise and zoom buttons, set into the page's
// header rather than over a title bar of their own: the window hides its title bar, and the
// page says where its header's middle is, so the buttons sit on it, and hears how much room
// they take, so it keeps clear of them.
import type { IpcMainEvent } from "electron"

import { windowControlsChannel, windowControlsPlaceChannel } from "../../bridge.js"

/**
 * Where the buttons sit, in the window's points: `left` from its left edge to the first,
 * `width` from the first's left edge to the last's right, and `height`, the drawn circle's (its
 * button is 16 high, the circle in its top 14).
 */
export const controlsMetrics = { left: 20, width: 54, height: 14 } as const

/** The middle of the page's header, in CSS pixels, before the page says where it is. */
export const headerMiddle = 32

// The middle a page asks for is a line in its header, never further down than this.
const lowestMiddle = 200

/** Where the buttons go, and the room the page keeps clear for them, in its CSS pixels. */
export type ControlsPlacement = {
  readonly visible: boolean
  readonly position: { readonly x: number; readonly y: number }
  readonly inset: number
}

/**
 * Where the buttons go for a page centring them on `middle` CSS pixels from its top (null:
 * hidden) at `zoom`, the app's scale. A window in full screen shows them only in the menu bar
 * that slides down with the pointer, so the page keeps no room for them then.
 */
export const placeControls = ({
  middle,
  zoom,
  fullScreen,
}: {
  readonly middle: number | null
  readonly zoom: number
  readonly fullScreen: boolean
}): ControlsPlacement => {
  const { left, width, height } = controlsMetrics
  const line = middle ?? headerMiddle
  return {
    visible: middle !== null,
    position: { x: left, y: Math.max(0, Math.round(line * zoom - height / 2)) },
    inset: middle === null || fullScreen ? 0 : Math.ceil((left + width) / zoom),
  }
}

/**
 * The window options that set the buttons into the page on macOS, at a page's first paint at
 * `zoom`; none elsewhere, whose windows keep the system's title bar.
 */
export const controlsWindowOptions = (
  inset: boolean,
  zoom: number,
): {
  readonly titleBarStyle?: "hiddenInset"
  readonly trafficLightPosition?: { readonly x: number; readonly y: number }
} =>
  inset
    ? {
        titleBarStyle: "hiddenInset",
        trafficLightPosition: placeControls({ middle: headerMiddle, zoom, fullScreen: false })
          .position,
      }
    : {}

/** A middle the page asked for: a line in its header, or null; undefined for anything else. */
export const middleOf = (value: unknown): number | null | undefined => {
  if (value === null) return null
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= lowestMiddle
    ? value
    : undefined
}

// The part of a window the buttons need.
export type ControlledWindow = {
  setWindowButtonVisibility(visible: boolean): void
  setWindowButtonPosition(position: { x: number; y: number } | null): void
  isFullScreen(): boolean
  isDestroyed(): boolean
  on(event: "enter-full-screen" | "leave-full-screen", listener: () => void): unknown
  readonly webContents: {
    getZoomFactor(): number
    isDestroyed(): boolean
    send(channel: string, inset: number): void
  }
}

/** A window's buttons: where its page last asked for them, put right again on each change. */
export type WindowControls = {
  // The page asks for them on `middle`, or hidden.
  readonly place: (middle: number | null) => void
  // Places them again, as when the page's zoom changed.
  readonly apply: () => void
}

/**
 * Keeps `window`'s buttons where its page asked, at its zoom, and tells the page the room they
 * take on each change, entering and leaving full screen among them: macOS shows the buttons
 * again as a window leaves full screen, so a page that hid them has them hidden again.
 */
export const keepControls = (window: ControlledWindow): WindowControls => {
  let middle: number | null = headerMiddle
  let told: number | undefined
  const apply = (): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    const placement = placeControls({
      middle,
      zoom: window.webContents.getZoomFactor(),
      fullScreen: window.isFullScreen(),
    })
    window.setWindowButtonVisibility(placement.visible)
    window.setWindowButtonPosition(placement.position)
    if (placement.inset === told) return
    told = placement.inset
    window.webContents.send(windowControlsChannel, placement.inset)
  }
  window.on("enter-full-screen", apply)
  window.on("leave-full-screen", apply)
  return {
    place: (next) => {
      middle = next
      // A page that loaded again asks first thing, and hears the room even when unchanged.
      told = undefined
      apply()
    },
    apply,
  }
}

type ControlsIpc = {
  on(channel: string, listener: (event: IpcMainEvent, middle: unknown) => void): unknown
}

/**
 * Places the buttons where the page asks: `controls` names the buttons of a request from the
 * app's own page, or undefined for any other sender, whose requests are dropped, as is a middle
 * that isn't one.
 */
export const registerControlsIpc = (
  ipc: ControlsIpc,
  controls: (event: IpcMainEvent) => WindowControls | undefined,
): void => {
  ipc.on(windowControlsPlaceChannel, (event, value) => {
    const middle = middleOf(value)
    if (middle === undefined) return
    controls(event)?.place(middle)
  })
}
