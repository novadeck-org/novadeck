import { phoneScreen } from "./phone.js"

// Where a live page's view goes in its viewer: the size it lays out at, scaled down to fit.
// No view here, only the arithmetic, which the desktop app's looks share for the sizes it loads at.

/**
 * What a live page lays out as: a desktop's window, at least `desktopWidth` wide and scaled
 * down to fit a narrower viewer, so a narrow viewer shows a site's desktop layout, not the
 * one it squeezes into; or a phone's screen, `phoneScreen`, in a phone's frame, kept a
 * phone's shape and scaled down whole to fit the viewer, so it reads as a phone in any.
 */
export type PageSize = "desktop" | "phone"

export const desktopWidth = 1024

/**
 * The room a phone's screen keeps on each side of it, in CSS pixels: its frame's bezel,
 * which browser.css draws, and a margin around the frame.
 */
export const phoneBezel = 10
export const phoneMargin = 16

/**
 * Where a live page's view goes in a viewer `width` by `height` wide: the size it lays out
 * at, how far it's scaled, and where it sits; undefined where it fills the viewer as it is.
 */
export type Framing = {
  readonly width: number
  readonly height: number
  readonly scale: number
  readonly left: number
  readonly top: number
}

export const framingOf = (size: PageSize, width: number, height: number): Framing | undefined => {
  if (width <= 0 || height <= 0) return undefined
  if (size === "desktop") {
    if (width >= desktopWidth) return undefined
    const scale = width / desktopWidth
    return { width: desktopWidth, height: height / scale, scale, left: 0, top: 0 }
  }
  const room = 2 * (phoneBezel + phoneMargin)
  const scale = Math.min(
    1,
    Math.max(1, width - room) / phoneScreen.width,
    Math.max(1, height - room) / phoneScreen.height,
  )
  return {
    width: phoneScreen.width,
    height: phoneScreen.height,
    scale,
    left: (width - phoneScreen.width * scale) / 2,
    top: (height - phoneScreen.height * scale) / 2,
  }
}

/** Whether the point `x`, `y` of the viewer is on the phone `framing` places, its frame included. */
export const onPhone = (framing: Framing, x: number, y: number): boolean =>
  x >= framing.left - phoneBezel &&
  x <= framing.left + framing.width * framing.scale + phoneBezel &&
  y >= framing.top - phoneBezel &&
  y <= framing.top + framing.height * framing.scale + phoneBezel

// A phone's zoom: one level past fit, to look closer at a detail. The viewer shows the phone
// at fit, centred and whole, or zoomed, as wide as the viewer less `phoneMargin` a side,
// unless that would show more than it can of its height; taller than the viewer then, it's
// moved up and down by its `lift`.

/** How much of a zoomed phone's height, its frame included, the viewer shows at most. */
export const zoomedShare = 0.6

/** The least a zoom must gain over fit to be worth offering. */
export const zoomGain = 1.1

/** Chromium zooms a page no further than five times. */
const maxPageZoom = 5

const phoneFrame = (scale: number): number => phoneScreen.height * scale + 2 * phoneBezel

/**
 * The scale a phone zooms to in a viewer `width` by `height`: as wide as the viewer less
 * `phoneMargin` a side, or the scale at which `zoomedShare` of its height is in view, the
 * smaller; undefined where that gains less than `zoomGain` over fit, as in a narrow viewer,
 * where there's nothing to zoom to.
 */
export const phoneZoomOf = (width: number, height: number): number | undefined => {
  const fit = framingOf("phone", width, height)
  if (!fit) return undefined
  const level = Math.min(
    (width - 2 * (phoneBezel + phoneMargin)) / phoneScreen.width,
    (height / zoomedShare - 2 * phoneBezel) / phoneScreen.height,
    maxPageZoom,
  )
  return level >= zoomGain * fit.scale ? level : undefined
}

/**
 * How far a phone drawn at `scale` reaches past a viewer `height` high, with `phoneMargin`
 * above and below it: how far it moves up and down, 0 where it fits.
 */
export const phoneTravel = (height: number, scale: number): number =>
  Math.max(0, phoneFrame(scale) + 2 * phoneMargin - height)

/**
 * A phone drawn at `scale` in a viewer `width` by `height`, centred across; up and down it's
 * centred where it fits, else `lift`, from 0 to 1, moves it from its top bezel `phoneMargin`
 * below the viewer's top to its bottom bezel `phoneMargin` above its bottom.
 */
export const phoneAt = (width: number, height: number, scale: number, lift: number): Framing => {
  const travel = phoneTravel(height, scale)
  const at = Math.min(1, Math.max(0, lift))
  return {
    width: phoneScreen.width,
    height: phoneScreen.height,
    scale,
    left: (width - phoneScreen.width * scale) / 2,
    top:
      travel > 0
        ? phoneMargin + phoneBezel - at * travel
        : (height - phoneScreen.height * scale) / 2,
  }
}

/**
 * The lift that keeps what's at `y` of the viewer where it is, as a phone `from` fit or
 * drawn anywhere zooms to `scale` in a viewer `height` high.
 */
export const liftAbout = (from: Framing, scale: number, y: number, height: number): number => {
  const travel = phoneTravel(height, scale)
  if (travel === 0) return 0
  // What's under the pointer, in the phone's own pixels, and where its top must then be.
  const top = y - ((y - from.top) / from.scale) * scale
  return Math.min(1, Math.max(0, (phoneMargin + phoneBezel - top) / travel))
}

/** A framing `p` of the way, from 0 to 1, from `from` to `to`. */
export const between = (from: Framing, to: Framing, p: number): Framing => ({
  ...to,
  scale: from.scale + (to.scale - from.scale) * p,
  left: from.left + (to.left - from.left) * p,
  top: from.top + (to.top - from.top) * p,
})

/** Ease in and out, for p from 0 to 1. */
export const easeOf = (p: number): number => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2)

/** The rail's width and its distance from the viewer's right, and its ends' from top and bottom. */
export const railWidth = 6
export const railInset = 5
export const railEnd = 12
const railLeast = 28

/**
 * A rail showing which part of a zoomed phone is in view, as a scrollbar's thumb in its
 * track: the track `length` long, the thumb as long as the share of the phone in view and at
 * `lift` of the way along. Undefined where the phone isn't taller than the viewer.
 */
export const railOf = (
  height: number,
  scale: number,
  lift: number,
): { readonly length: number; readonly thumb: number; readonly at: number } | undefined => {
  const travel = phoneTravel(height, scale)
  if (travel === 0) return undefined
  const length = Math.max(1, height - 2 * railEnd)
  const thumb = Math.min(length, Math.max(railLeast, (length * height) / (height + travel)))
  return { length, thumb, at: Math.min(1, Math.max(0, lift)) * (length - thumb) }
}

/**
 * The lift for a pointer at `y` of the rail's track, `length` long from `top` at the track's
 * start, holding a thumb `thumb` long at its middle, as a press on the track or a drag of it.
 */
export const liftAtRail = (y: number, top: number, length: number, thumb: number): number =>
  length <= thumb ? 0 : Math.min(1, Math.max(0, (y - top - thumb / 2) / (length - thumb)))
