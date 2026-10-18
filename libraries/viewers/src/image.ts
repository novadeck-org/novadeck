import { hashOf } from "./hash.js"
import { createHold } from "./hold.js"
import type { Mount, Viewer, ViewerState } from "./index.js"

// An image, fitted to its viewer or at its actual size, scrolling when it's larger. The
// zoom is part of its state, so an image shown again keeps it, and its place. Its looks
// are image.css's.

export type ImageContent = { readonly src: string; readonly alt: string }

export type ImageViewer = Viewer<ImageContent> & {
  /** At its actual size, or fitted. */
  readonly zoom: (actual: boolean) => void
}

export type ImageOptions = {
  /** Told the zoom at mount, and whenever it changes. */
  readonly onZoom?: (actual: boolean) => void
}

type ImageState = {
  readonly image: {
    // A hash of the image's address, which may be a whole image as a data URL.
    readonly src: string
    readonly actual: boolean
    readonly top: number
    readonly left: number
  }
}

// What names an image's address in its state: its length and a hash.
const keyOf = (src: string): string => `${src.length}:${hashOf(src)}`

const isImageState = (state: unknown): state is ImageState => {
  const image = (state as Partial<ImageState> | null)?.image
  return (
    typeof image?.src === "string" &&
    typeof image.actual === "boolean" &&
    typeof image.top === "number" &&
    typeof image.left === "number"
  )
}

export const mountImage: Mount<ImageContent, ImageOptions, ImageViewer> = (
  element,
  { content, label, saved, onZoom },
) => {
  const document = element.ownerDocument
  const root = document.createElement("div")
  root.className = "image-viewer"
  root.setAttribute("role", "region")
  root.setAttribute("aria-label", label)
  // Focusable, so a zoomed image can be scrolled by keyboard.
  root.tabIndex = 0
  const image = document.createElement("img")
  root.append(image)
  element.append(root)

  let shown = content
  let actual = false
  const { hold, release, refresh } = createHold(
    root,
    () => [image],
    () => image.complete,
  )

  // An image may have its size before it has loaded, so loading counts on its own.
  image.addEventListener("load", refresh)
  image.addEventListener("error", refresh)

  // Its address's key, kept while it shows: a data URL can be megabytes to hash.
  let key = ""
  const show = (): void => {
    key = keyOf(shown.src)
    image.src = shown.src
    image.alt = shown.alt
  }

  const zoom = (next: boolean): void => {
    actual = next
    root.toggleAttribute("data-actual", actual)
    onZoom?.(actual)
  }

  // A place in this image.
  const isPlace = (state: ViewerState | undefined): state is ImageState & ViewerState =>
    isImageState(state) && state.image.src === key

  const restore = (state: ViewerState): void => {
    if (!isPlace(state)) return
    const { top, left } = state.image
    zoom(state.image.actual)
    hold(() => {
      root.scrollTop = top
      root.scrollLeft = left
    })
  }

  show()
  if (isPlace(saved)) restore(saved)
  else zoom(false)

  return {
    update: (next) => {
      const previous = shown
      shown = next
      if (previous.src === next.src) {
        image.alt = next.alt
        return
      }
      release()
      show()
    },
    state: () =>
      ({
        image: { src: key, actual, top: root.scrollTop, left: root.scrollLeft },
      }) satisfies ImageState as unknown as ViewerState,
    restore,
    // An image has no lines or text to jump to.
    jumpTo: () => undefined,
    focus: () => root.focus({ preventScroll: true }),
    zoom: (next) => {
      release()
      zoom(next)
    },
    destroy: () => {
      release()
      image.removeEventListener("load", refresh)
      image.removeEventListener("error", refresh)
      root.remove()
    },
  }
}
