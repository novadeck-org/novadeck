import { createContext, useCallback, useContext, useEffect, useRef } from "react"

// A companion pane coming back into sight stands in for what it shows until its turn (see
// ./pane-turns): where the app can picture its own page, as the desktop app can, it stands
// in as a picture of itself as it was last drawn, rather than as its icon and name. While a
// pane is built and in sight, its picture is kept fresh: `firstMs` after it's laid out,
// `leftMs` after the pointer leaves it, and every `freshenMs`, each only once what it shows
// has changed since, as told by its DOM changing, a scroll in it or its size.

// A picture of a pane: what it showed, decoded, ready to draw at once, and the size it was
// laid out at then, in CSS pixels, as it shows only where the pane is that size again.
export type PanePicture = {
  readonly image: HTMLImageElement
  readonly width: number
  readonly height: number
}

// A part of the page in CSS pixels of its viewport.
export type PaneRect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

// A picture of part of the page as it's drawn now, a JPEG `data:` address; undefined where
// none comes. The desktop app's, through the backend.
export type Shoot = (rect: PaneRect) => Promise<string | undefined>

export type PanePictures = {
  // Whether pictures can be taken here now.
  readonly can: () => boolean
  // A picture of `element` as it's drawn now; undefined where it isn't wholly in view,
  // uncovered, or none comes.
  readonly take: (element: HTMLElement) => Promise<PanePicture | undefined>
}

// Outside the workspace, and where the page can't picture itself (a browser), none are taken.
export const PanePicturesContext = createContext<PanePictures | undefined>(undefined)

/** How soon after a pane is laid out its first picture is taken. */
export const firstMs = 1_000
/** How often a pane's picture is freshened while what it shows changes. */
export const freshenMs = 5_000
/** How soon after the pointer leaves a pane its picture is freshened. */
export const leftMs = 300

// The demo's debug panel has panes pictured as sketches of their layout while the page's
// root carries this, where the page can't picture itself, so the picture can be looked at.
export const sketchedAttribute = "data-pane-pictures-sketched"

const sketched = (): boolean =>
  typeof document !== "undefined" && document.documentElement.hasAttribute(sketchedAttribute)

// Whether `element`, drawn at `rect`, is wholly in the window and nothing covers it: at its
// middle and near each corner, what's on top is it or in it, as no dialog, menu or Canvas
// tile is over it.
const uncovered = (element: HTMLElement, rect: DOMRect): boolean => {
  if (rect.width < 1 || rect.height < 1) return false
  if (rect.left < 0 || rect.top < 0) return false
  if (rect.right > window.innerWidth || rect.bottom > window.innerHeight) return false
  const inset = Math.min(4, rect.width / 4, rect.height / 4)
  const points: readonly (readonly [number, number])[] = [
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
    [rect.left + inset, rect.top + inset],
    [rect.right - inset, rect.top + inset],
    [rect.left + inset, rect.bottom - inset],
    [rect.right - inset, rect.bottom - inset],
  ]
  return points.every(([x, y]) => {
    const top = document.elementFromPoint(x, y)
    return top !== null && element.contains(top)
  })
}

// How many of a pane's elements a sketch draws, at most.
const sketchedElements = 200

// A sketch of `element`'s layout as an SVG `data:` address, `width` by `height` (its layout
// size; `rect` is where it's drawn, as a Canvas zoom scales it): an outline of each element
// in it, over its background.
const sketch = (element: HTMLElement, rect: DOMRect, width: number, height: number): string => {
  const scale = rect.width / width || 1
  let ground = "transparent"
  for (let at: Element | null = element; at; at = at.parentElement) {
    const color = getComputedStyle(at).backgroundColor
    if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") {
      ground = color
      break
    }
  }
  const ink = getComputedStyle(element).color || "gray"
  const boxes = [...element.querySelectorAll("*")]
    .slice(0, sketchedElements)
    .map((each) => each.getBoundingClientRect())
    .filter((box) => box.width >= 1 && box.height >= 1)
    .map(
      (box) =>
        `<rect x="${(box.left - rect.left) / scale}" y="${(box.top - rect.top) / scale}" ` +
        `width="${box.width / scale}" height="${box.height / scale}" rx="2"/>`,
    )
    .join("")
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${ground}"/>` +
    `<g fill="none" stroke="${ink}" stroke-opacity="0.35">${boxes}</g></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

// The picture at `src`, decoded, so it draws in the frame it's put in.
const decoded = async (src: string): Promise<HTMLImageElement | undefined> => {
  const image = new Image()
  image.alt = ""
  image.decoding = "sync"
  image.src = src
  // Where images can't be decoded ahead, as in a test's document, it decodes as it draws.
  if (typeof image.decode !== "function") return image
  try {
    await image.decode()
    return image
  } catch {
    return undefined
  }
}

/**
 * Pictures of panes, taken with `shoot` where the page can picture itself, else, while the
 * demo's debug panel asks, sketched (see `sketchedAttribute`).
 */
export const createPanePictures = (shoot: Shoot | undefined): PanePictures => ({
  can: () => shoot !== undefined || sketched(),
  take: async (element) => {
    const rect = element.getBoundingClientRect()
    if (!uncovered(element, rect)) return undefined
    // The size it's laid out at, whatever scales it as it's drawn.
    const width = element.offsetWidth
    const height = element.offsetHeight
    const src = shoot
      ? await shoot({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
      : sketched()
        ? sketch(element, rect, width, height)
        : undefined
    const image = src === undefined ? undefined : await decoded(src)
    return image && { image, width, height }
  },
})

/**
 * Keeps a picture of the pane drawn in `element` while it's `live` (built, laid out and in
 * sight), for what it shows as `key`. Returns the latest picture of what it shows now, if
 * any: one of anything else it showed doesn't count.
 */
export const usePanePicture = (
  element: HTMLElement | null,
  live: boolean,
  key: string | undefined,
): (() => PanePicture | undefined) => {
  const pictures = useContext(PanePicturesContext)
  const kept = useRef<{ readonly key: string; readonly picture: PanePicture } | undefined>(
    undefined,
  )
  useEffect(() => {
    if (!live || !element || key === undefined || !pictures?.can()) return
    // Whether what it shows changed since its last picture. Told once, it stops listening
    // until the next picture, so a busy pane costs a call per picture, not one per change.
    let changed = true
    let taking = false
    let gone = false
    const watch = (): void => {
      observer.observe(element, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      })
      resized?.observe(element)
    }
    const change = (): void => {
      if (changed) return
      changed = true
      observer.disconnect()
      resized?.disconnect()
    }
    const observer = new MutationObserver(change)
    // A size observer tells of the size it has at once, which is no change.
    let sized = false
    const resized =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            if (sized) change()
            sized = true
          })
        : undefined
    const take = (): void => {
      if (!changed || taking || document.visibilityState === "hidden") return
      changed = false
      taking = true
      sized = false
      watch()
      void pictures.take(element).then(
        (picture) => {
          taking = false
          if (gone) return
          if (picture) kept.current = { key, picture }
          // None came, as when it was covered: tried again on the next freshen.
          else change()
        },
        () => {
          taking = false
          if (!gone) change()
        },
      )
    }
    const scrolled = (): void => change()
    let left: ReturnType<typeof setTimeout> | undefined
    const leave = (): void => {
      clearTimeout(left)
      left = setTimeout(take, leftMs)
    }
    element.addEventListener("scroll", scrolled, { capture: true, passive: true })
    element.addEventListener("pointerleave", leave)
    const first = setTimeout(take, firstMs)
    const every = setInterval(take, freshenMs)
    return () => {
      gone = true
      observer.disconnect()
      resized?.disconnect()
      element.removeEventListener("scroll", scrolled, { capture: true })
      element.removeEventListener("pointerleave", leave)
      clearTimeout(first)
      clearTimeout(left)
      clearInterval(every)
    }
  }, [pictures, element, live, key])
  return useCallback(() => {
    const picture = kept.current
    return picture !== undefined && picture.key === key ? picture.picture : undefined
  }, [key])
}
