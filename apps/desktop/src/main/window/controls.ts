// The window's own controls set into the page's header rather than over a title bar of their
// own: the window hides its title bar, and the page says where its header's middle is, so the
// controls sit on it, and hears how much room they take, so it keeps clear of them. On macOS
// (the `start` side) they are the close, minimise and zoom buttons at the header's start, and the
// page can hide them; on Windows (the `end` side) they are the caption buttons Electron draws
// over the page's top-right corner, in its header, as tall as a Windows 11 app's title bar, which
// can't hide while the window lasts, so the page always places them.
import type { WindowControlsSide } from "@novadeck/protocol/bridge"
import type { IpcMainEvent } from "electron"

import { windowControlsChannel, windowControlsPlaceChannel } from "../../bridge.js"

/**
 * Where macOS's buttons sit, in the window's points: `left` from its left edge to the first,
 * on the line of the rail's icons below, `width` from the first's left edge to the last's right,
 * and `height`, the drawn circle's (its button is 16 high, the circle in its top 14).
 */
export const controlsMetrics = { left: 16, width: 54, height: 14 } as const

/**
 * How wide Windows' three caption buttons are together, in the window's points, before the page
 * measures them (the preload does, where the page can): 46 each, as Windows 11's own.
 */
export const captionWidth = 138

/**
 * The middle of what the controls sit on, in CSS pixels, before the page says where it is: at
 * the start the page's header, a macOS toolbar's 52 high; at the end the buttons' own band from
 * the page's top, a Windows 11 app's standard title bar's 32, as Explorer's and Paint's.
 */
export const headerMiddles = { start: 26, end: 16 } as const satisfies Record<
  WindowControlsSide,
  number
>

// The middle a page asks for is a line in its header, never further down than this.
const lowestMiddle = 200

/** Where macOS's buttons go, and the room the page keeps clear for them, in its CSS pixels. */
export type ControlsPlacement = {
  readonly visible: boolean
  readonly position: { readonly x: number; readonly y: number }
  readonly inset: number
}

/**
 * Where macOS's buttons go for a page centring them on `middle` CSS pixels from its top (null:
 * hidden) at `zoom`, the app's scale. A window in full screen shows them only in the menu bar
 * that slides down with the pointer, so the page keeps no room for them then, and they stay
 * there even where the page hides them (as Zen does), the bar being their only way back.
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
  const line = middle ?? headerMiddles.start
  return {
    visible: middle !== null || fullScreen,
    position: { x: left, y: Math.max(0, Math.round(line * zoom - height / 2)) },
    inset: middle === null || fullScreen ? 0 : Math.ceil((left + width) / zoom),
  }
}

/** Windows' caption buttons for a page centring them on `middle`: their height and the room. */
export type CaptionPlacement = { readonly height: number; readonly inset: number }

/**
 * Windows' caption buttons for a page centring them on `middle` CSS pixels from its top at
 * `zoom`: they run from the window's top, so they are twice the middle high, in the window's
 * points. They can't hide, so a page asking for none (null) gets them 32 high.
 * In full screen Windows leaves them out, and the page keeps no room for them.
 */
export const placeCaption = ({
  middle,
  zoom,
  fullScreen,
}: {
  readonly middle: number | null
  readonly zoom: number
  readonly fullScreen: boolean
}): CaptionPlacement => ({
  height: Math.max(1, Math.round(2 * (middle ?? headerMiddles.end) * zoom)),
  inset: fullScreen ? 0 : Math.ceil(captionWidth / zoom),
})

/** The colour Windows' caption buttons draw their symbols in: the page's ink, as `#rrggbb`. */
const symbolPattern = /^#[0-9a-f]{6}$/

/**
 * The ground Windows' caption buttons draw on: the page's `ground`, but clear, so the header under
 * them shows through. Electron tints a hovered button against the ground's colour, alpha aside,
 * so on a light page it darkens and on a dark one it lightens, as Windows' own buttons do; a
 * clear black would lighten it on every page.
 */
export const captionGround = (ground: string): string =>
  symbolPattern.test(ground) ? `${ground}00` : "#00000000"

/** The ink for a window's caption buttons before the page says: one that reads on `ground`. */
export const symbolOn = (ground: string): string => {
  const value = Number.parseInt(ground.slice(1, 7), 16)
  if (!symbolPattern.test(ground) || Number.isNaN(value)) return "#000000"
  const light = 0.299 * (value >> 16) + 0.587 * ((value >> 8) & 0xff) + 0.114 * (value & 0xff)
  return light > 140 ? "#1a1a1a" : "#f2f2f2"
}

/**
 * The window options that set the controls into the page's top on `side`, at a page's first
 * paint at `zoom`: macOS's buttons inset at the start; Windows' caption buttons at the end, on
 * a clear ground so the header shows through, their symbols in `ink`, the page's last (or one
 * that reads on its `ground`). None where the window keeps the system's title bar (undefined).
 */
export const controlsWindowOptions = (
  side: WindowControlsSide | undefined,
  {
    zoom,
    ground,
    ink,
  }: { readonly zoom: number; readonly ground: string; readonly ink?: string | undefined },
): {
  readonly titleBarStyle?: "hiddenInset" | "hidden"
  readonly trafficLightPosition?: { readonly x: number; readonly y: number }
  readonly titleBarOverlay?: {
    readonly color: string
    readonly symbolColor: string
    readonly height: number
  }
} => {
  if (side === "start")
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: placeControls({
        middle: headerMiddles.start,
        zoom,
        fullScreen: false,
      }).position,
    }
  if (side === "end")
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: captionGround(ground),
        symbolColor: ink && symbolPattern.test(ink) ? ink : symbolOn(ground),
        height: placeCaption({ middle: headerMiddles.end, zoom, fullScreen: false }).height,
      },
    }
  return {}
}

/** A middle the page asked for: a line in its header, or null; undefined for anything else. */
export const middleOf = (value: unknown): number | null | undefined => {
  if (value === null) return null
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= lowestMiddle
    ? value
    : undefined
}

// The part of a window either side's controls need.
type WindowBase = {
  isFullScreen(): boolean
  isDestroyed(): boolean
  on(event: "enter-full-screen" | "leave-full-screen", listener: () => void): unknown
  readonly webContents: {
    getZoomFactor(): number
    isDestroyed(): boolean
    send(channel: string, inset: number): void
    on(event: "did-navigate" | "render-process-gone", listener: () => void): unknown
  }
}

/** The part of a macOS window its buttons need. */
export type ControlledWindow = WindowBase & {
  setWindowButtonVisibility(visible: boolean): void
  setWindowButtonPosition(position: { x: number; y: number } | null): void
}

/** The part of a Windows window its caption buttons need. */
export type CaptionWindow = WindowBase & {
  setTitleBarOverlay(options: { height?: number; color?: string; symbolColor?: string }): void
}

/** A window's controls: where its page last asked for them, put right again on each change. */
export type WindowControls = {
  // The page asks for them on `middle`, or hidden.
  readonly place: (middle: number | null) => void
  // Places them again, as when the page's zoom changed.
  readonly apply: () => void
  // Draws them in the page's ink on its ground, each as `#rrggbb` (Windows' caption buttons;
  // macOS's keep theirs).
  readonly paint: (look: { readonly ground: string; readonly ink?: string | undefined }) => void
}

/**
 * Keeps a window's controls where its page asked, through `put` (which places them at the zoom
 * and says the room they take), and tells the page the room on each change, entering and leaving
 * full screen among them. A page that goes, as it loads again or crashes, takes what it asked
 * with it: the controls go back to the header's middle, shown, for whatever the window shows
 * next.
 */
const keep = (
  window: WindowBase,
  first: number,
  put: (middle: number | null, zoom: number, fullScreen: boolean) => number,
): Pick<WindowControls, "place" | "apply"> => {
  let middle: number | null = first
  let told: number | undefined
  const apply = (): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    const inset = put(middle, window.webContents.getZoomFactor(), window.isFullScreen())
    if (inset === told) return
    told = inset
    window.webContents.send(windowControlsChannel, inset)
  }
  window.on("enter-full-screen", apply)
  window.on("leave-full-screen", apply)
  const reset = (): void => {
    middle = first
    told = undefined
    apply()
  }
  // Once a new page commits, as a reload; the app's own routes move within the page.
  window.webContents.on("did-navigate", reset)
  window.webContents.on("render-process-gone", reset)
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

/**
 * Keeps a macOS window's buttons where its page asked, at its zoom: macOS shows them again as a
 * window leaves full screen, so a page that hid them has them hidden again.
 */
export const keepControls = (window: ControlledWindow): WindowControls => ({
  ...keep(window, headerMiddles.start, (middle, zoom, fullScreen) => {
    const placement = placeControls({ middle, zoom, fullScreen })
    window.setWindowButtonVisibility(placement.visible)
    window.setWindowButtonPosition(placement.position)
    return placement.inset
  }),
  paint: () => {},
})

/**
 * Keeps a Windows window's caption buttons twice as tall as the line the page centres them on, at its
 * zoom, and in the page's ink on its ground. Only a changed height, ground or ink is set, as each
 * repaints them.
 */
export const keepCaption = (window: CaptionWindow): WindowControls => {
  let height: number | undefined
  const kept = keep(window, headerMiddles.end, (middle, zoom, fullScreen) => {
    const placement = placeCaption({ middle, zoom, fullScreen })
    if (placement.height !== height) {
      height = placement.height
      window.setTitleBarOverlay({ height })
    }
    return placement.inset
  })
  let ink: string | undefined
  let ground: string | undefined
  return {
    ...kept,
    paint: (look) => {
      if (window.isDestroyed()) return
      const color = symbolPattern.test(look.ground) ? captionGround(look.ground) : undefined
      const symbolColor = look.ink && symbolPattern.test(look.ink) ? look.ink : undefined
      const changed = {
        ...(color && color !== ground ? { color } : {}),
        ...(symbolColor && symbolColor !== ink ? { symbolColor } : {}),
      }
      if (!changed.color && !changed.symbolColor) return
      ground = changed.color ?? ground
      ink = changed.symbolColor ?? ink
      window.setTitleBarOverlay(changed)
    },
  }
}

type ControlsIpc = {
  on(channel: string, listener: (event: IpcMainEvent, middle: unknown) => void): unknown
}

/**
 * Places the controls where the page asks: `controls` names the controls of a request from the
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
