import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react"

// A companion pane coming back into sight stands in for what it shows until its turn (see
// ./pane-turns): where the app can picture its own page, as the desktop app can, it stands
// in as a picture of itself as it was last drawn, rather than as its icon and name. While a
// pane is built and in sight, its picture is kept fresh: `firstMs` after it's laid out,
// `leftMs` after the pointer or focus leaves it, and every `freshenMs`, each only once what
// it shows has changed since, as told by its DOM changing, a scroll in it, its size, the
// page's look, or the pointer or focus leaving it (which a hover or focus ring showed).
// Pictures are taken one at a time, so panes a view shows at once don't all ask together. They
// are kept by key, a few dozen at most, so what remounts (a chat, as its view comes back) finds
// its own again; one whose content the caller can name (a chat's conversation) is taken only
// once that has settled, and shows only while it is still what the picture shows.

// A picture of a pane: what it showed, decoded, ready to draw at once, and the size it was
// laid out at then, in CSS pixels, and the page's look then (see `pageLook`), as it shows
// only where the pane is that size again, in that look.
export type PanePicture = {
  readonly image: HTMLImageElement
  readonly width: number
  readonly height: number
  readonly look: string
  // What it showed, as the caller names it (see `usePanePicture`'s `mark`), where it does.
  readonly mark?: string | undefined
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
  // The picture kept by `key`, and keeping one there.
  readonly kept: (key: string) => PanePicture | undefined
  readonly keep: (key: string, picture: PanePicture) => void
  // Lets the picture kept by `key` go.
  readonly forget: (key: string) => void
}

// Outside the workspace, and where the page can't picture itself (a browser), none are taken.
export const PanePicturesContext = createContext<PanePictures | undefined>(undefined)

/** How soon after a pane is laid out its first picture is taken. */
export const firstMs = 1_000
/** How often a pane's picture is freshened while what it shows changes. */
export const freshenMs = 5_000
/** How soon after the pointer leaves a pane its picture is freshened. */
export const leftMs = 300
/** How many pictures are kept, the latest kept or shown last to go. */
export const keptMost = 32

// The demo's debug panel has panes pictured as sketches of their layout while the page's
// root carries this, where the page can't picture itself, so the picture can be looked at.
export const sketchedAttribute = "data-pane-pictures-sketched"

const sketched = (): boolean =>
  typeof document !== "undefined" && document.documentElement.hasAttribute(sketchedAttribute)

// What on the page's root changes how every pane looks: its theme, scheme and ligatures.
const lookAttributes = ["data-theme", "data-scheme", "data-ligatures"]

/** The page's look now, as a picture of a pane was taken in and shows only in. */
export const pageLook = (): string =>
  lookAttributes.map((name) => document.documentElement.getAttribute(name) ?? "").join(" ")

// What floats over the page outside a pane, from a portal: a menu, a tooltip, a dialog, a
// list that drops down, or any positioned popup.
const floating =
  '[role="menu"], [role="tooltip"], [role="dialog"], [role="alertdialog"], [role="listbox"], ' +
  '[data-part="positioner"]'

// Whether something floating outside `element` overlaps `rect`, where it's drawn.
const overlaid = (element: HTMLElement, rect: DOMRect): boolean =>
  [...document.querySelectorAll(floating)].some((each) => {
    if (element.contains(each)) return false
    const box = each.getBoundingClientRect()
    return (
      box.width > 0 &&
      box.height > 0 &&
      box.left < rect.right &&
      box.right > rect.left &&
      box.top < rect.bottom &&
      box.bottom > rect.top
    )
  })

// Whether `element` is still drawn at `rect`: a pan or a scroll meanwhile moved it.
const stayed = (element: HTMLElement, rect: DOMRect): boolean => {
  const now = element.getBoundingClientRect()
  return (
    Math.abs(now.left - rect.left) <= 1 &&
    Math.abs(now.top - rect.top) <= 1 &&
    Math.abs(now.width - rect.width) <= 1 &&
    Math.abs(now.height - rect.height) <= 1
  )
}
// Whether `element`, drawn at `rect`, is wholly in the window and nothing covers it: nothing
// floating overlaps it, and at its middle and near each corner, what's on top is it or in
// it, as no Canvas tile is over it.
const uncovered = (element: HTMLElement, rect: DOMRect): boolean => {
  if (rect.width < 1 || rect.height < 1) return false
  if (rect.left < 0 || rect.top < 0) return false
  if (rect.right > window.innerWidth || rect.bottom > window.innerHeight) return false
  if (overlaid(element, rect)) return false
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
export const createPanePictures = (shoot: Shoot | undefined): PanePictures => {
  const take = async (element: HTMLElement): Promise<PanePicture | undefined> => {
    if (!element.isConnected) return undefined
    const rect = element.getBoundingClientRect()
    if (!uncovered(element, rect)) return undefined
    // The size it's laid out at, whatever scales it as it's drawn.
    const width = element.offsetWidth
    const height = element.offsetHeight
    const look = pageLook()
    const src = shoot
      ? await shoot({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
      : sketched()
        ? sketch(element, rect, width, height)
        : undefined
    // Moved while it was taken, it's a picture of somewhere else.
    if (src === undefined || !stayed(element, rect)) return undefined
    const image = await decoded(src)
    return image && { image, width, height, look }
  }
  // The picture under way, which the next waits for.
  let last: Promise<unknown> = Promise.resolve()
  // By key, the one kept or shown longest ago first.
  const kept = new Map<string, PanePicture>()
  return {
    can: () => shoot !== undefined || sketched(),
    take: (element) => {
      const next = last.then(() => take(element))
      last = next.catch(() => undefined)
      return next
    },
    kept: (key) => {
      const picture = kept.get(key)
      if (picture === undefined) return undefined
      kept.delete(key)
      kept.set(key, picture)
      return picture
    },
    forget: (key) => void kept.delete(key),
    keep: (key, picture) => {
      kept.delete(key)
      kept.set(key, picture)
      for (const old of kept.keys()) {
        if (kept.size <= keptMost) break
        kept.delete(old)
      }
    },
  }
}

/**
 * Keeps a picture of the pane drawn in `element` while it's `live` (built, laid out and in
 * sight), for what it shows as `key`. Returns the latest picture kept by `key`, if any: one
 * kept by any other doesn't count. Where `mark` names what it shows (a word that changes as
 * that does), a picture is taken only once that holds still from one freshen to the next, and
 * counts only while it still names it. One `own` to this caller (a pane's, which no remount
 * finds again) goes as the key changes or the caller unmounts.
 */
export const usePanePicture = (
  element: HTMLElement | null,
  live: boolean,
  key: string | undefined,
  mark?: () => string,
  own = false,
): (() => PanePicture | undefined) => {
  const pictures = useContext(PanePicturesContext)
  useEffect(
    () => (own && pictures && key !== undefined ? () => pictures.forget(key) : undefined),
    [own, pictures, key],
  )
  const named = useRef(mark)
  useLayoutEffect(() => {
    named.current = mark
  })
  useEffect(() => {
    if (!live || !element || key === undefined || !pictures?.can()) return
    // What it showed at the last freshen, where it's named: a picture waits until it holds.
    let lastMark = named.current?.()
    // Whether what it shows changed since its last picture. Told once, it stops listening
    // until the next picture, so a busy pane costs a call per picture, not one per change.
    let changed = true
    let taking = false
    let gone = false
    const watch = (): void => {
      looked.observe(document.documentElement, { attributeFilter: lookAttributes })
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
      looked.disconnect()
      resized?.disconnect()
    }
    const observer = new MutationObserver(change)
    const looked = new MutationObserver(change)
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
      const marked = named.current?.()
      const settled = marked === lastMark
      lastMark = marked
      if (!settled) return
      changed = false
      taking = true
      sized = false
      watch()
      void pictures.take(element).then(
        (picture) => {
          taking = false
          if (gone) return
          if (picture) pictures.keep(key, { ...picture, mark: marked })
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
    // Left, it shows no hover or focus ring the last picture may have.
    let left: ReturnType<typeof setTimeout> | undefined
    const leave = (event: Event): void => {
      if (
        event.type === "focusout" &&
        element.contains((event as FocusEvent).relatedTarget as Node)
      )
        return
      change()
      clearTimeout(left)
      left = setTimeout(take, leftMs)
    }
    element.addEventListener("scroll", scrolled, { capture: true, passive: true })
    element.addEventListener("pointerleave", leave)
    element.addEventListener("focusout", leave)
    const first = setTimeout(take, firstMs)
    const every = setInterval(take, freshenMs)
    return () => {
      gone = true
      observer.disconnect()
      looked.disconnect()
      resized?.disconnect()
      element.removeEventListener("scroll", scrolled, { capture: true })
      element.removeEventListener("pointerleave", leave)
      element.removeEventListener("focusout", leave)
      clearTimeout(first)
      clearTimeout(left)
      clearInterval(every)
    }
  }, [pictures, element, live, key])
  return useCallback(() => {
    const picture = key === undefined ? undefined : pictures?.kept(key)
    if (picture === undefined) return undefined
    return named.current === undefined || picture.mark === named.current() ? picture : undefined
  }, [pictures, key])
}

// How far, in CSS pixels, a pane may be from the size its picture was taken at for the
// picture to stand in: a rounding's worth.
const pictureFitPx = 1

/**
 * Shows `picture()` in the stand-in the returned ref is put on, over what it holds, where there is one taken in
 * the page's look now and at the size of what the stand-in stands in for (its parent): put in
 * before the frame draws, decoded already, so the frame shows it, and taken out again if that
 * changes size while it stands in. The stand-in carries data-pictured while it shows one.
 */
export const useStandInPicture = <Element extends HTMLElement>(
  picture: () => PanePicture | undefined,
): RefObject<Element | null> => {
  const element = useRef<Element>(null)
  useLayoutEffect(() => {
    const standIn = element.current
    const sheet = standIn?.parentElement
    const shown = picture()
    if (!standIn || !sheet || !shown || shown.look !== pageLook()) return
    const { image } = shown
    image.className = "pane-stand-in-picture"
    image.setAttribute("aria-hidden", "true")
    const fit = (): void => {
      const fits =
        Math.abs(sheet.offsetWidth - shown.width) <= pictureFitPx &&
        Math.abs(sheet.offsetHeight - shown.height) <= pictureFitPx
      if (fits && image.parentElement !== standIn) standIn.append(image)
      if (!fits) image.remove()
      if (fits) standIn.dataset.pictured = "true"
      else delete standIn.dataset.pictured
    }
    fit()
    const resized = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : undefined
    resized?.observe(sheet)
    return () => {
      resized?.disconnect()
      image.remove()
      delete standIn.dataset.pictured
    }
  }, [picture])
  return element
}
