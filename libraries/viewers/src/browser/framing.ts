import { phoneScreen } from "./phone.js"

// Where a live page's view goes in its viewer: the size it lays out at, scaled down to fit.
// No view here, only the arithmetic, which the host's look shares for the sizes it loads at.

/**
 * What a live page lays out as: a desktop's window, at least `desktopWidth` wide and scaled
 * down to fit a narrower viewer, so a narrow viewer shows a site's desktop layout, not the
 * one it squeezes into; or a phone's screen, `phoneScreen`, in a phone's frame, kept a
 * phone's shape and scaled down whole to fit the viewer, so it reads as a phone in any.
 */
export type PageSize = "desktop" | "phone"

export const desktopWidth = 1280

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
