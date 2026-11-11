import type { ChatImage } from "@novadeck/core/conversation"
import { Dialog } from "@novadeck/toolkit/Dialog"
import { createKept, type ViewerState } from "@novadeck/viewers"
import { mountImage } from "@novadeck/viewers/image"
import { useViewer } from "@novadeck/viewers/react"
import { X } from "lucide-react"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"

import type { Attachment } from "./attachments"
import { createThumbCache, type ThumbCache } from "./thumb-cache"

// What the thumbnails of a recorded prompt draw on, from the chat around them:
// - `fetch`: the picture of an image by its record, as a data URL, or null where there is none;
//   absent where the backend can't find one again;
// - `cache`: the pictures asked for so far, kept for the chat's life;
// - `previews`: the images this window sent with a prompt, by the id of the item that records it,
//   in order, which show at once, where it still has them.
export type Thumbs = {
  readonly fetch: ((image: ChatImage) => Promise<string | null>) | undefined
  readonly cache: ThumbCache
  readonly previews: (item: string) => readonly Attachment[] | undefined
}

const nothing: Thumbs = {
  fetch: undefined,
  cache: createThumbCache(),
  previews: () => undefined,
}

export const ThumbsContext = createContext<Thumbs>(nothing)

/** The thumbnails a chat draws, given how it finds a picture and what this window sent. */
export const useThumbs = (fetch: Thumbs["fetch"], previews: Thumbs["previews"]): Thumbs => {
  const [cache] = useState(() => createThumbCache())
  return useMemo(() => ({ fetch, cache, previews }), [fetch, cache, previews])
}

// The words that name image `at` of `count` in a prompt: its own `[Image #N]` where the words
// have as many placeholders as there are images, else its place.
export const labelsOf = (text: string, count: number): readonly string[] => {
  const marks = text.match(/\[Image #\d+\]/g) ?? []
  return Array.from({ length: count }, (_, at) =>
    marks.length === count ? marks[at]!.slice(1, -1) : `Image ${at + 1}`,
  )
}

// Whether the element is, or nears, the view: at once where the browser can't tell.
const useNear = (): readonly [(element: Element | null) => void, boolean] => {
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined")
  const watcher = useRef<IntersectionObserver>(null)
  const watch = useCallback(
    (element: Element | null): void => {
      watcher.current?.disconnect()
      watcher.current = null
      if (!element || near || typeof IntersectionObserver === "undefined") return
      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return
          observer.disconnect()
          setNear(true)
        },
        { rootMargin: "400px 0px" },
      )
      observer.observe(element)
      watcher.current = observer
    },
    [near],
  )
  return [watch, near]
}

type Picture =
  | { readonly state: "wait" }
  | { readonly state: "none" }
  | { readonly state: "ready"; readonly src: string }

// One thumbnail: this window's own preview where it has it, else the picture once its row nears
// the view, a quiet box while it comes, and its name where there is none.
const Thumb = ({
  item,
  image,
  label,
  preview,
}: {
  readonly item: string
  readonly image: ChatImage
  readonly label: string
  readonly preview: string | undefined
}): React.JSX.Element => {
  const { fetch, cache } = useContext(ThumbsContext)
  // The latest way to ask, read when the effect runs: a new one never asks again for a picture.
  const asking = useRef(fetch)
  useEffect(() => {
    asking.current = fetch
  })
  const [watch, near] = useNear()
  // A preview this window let go of meanwhile is none: the picture is asked for instead.
  const [lost, setLost] = useState(false)
  const own = lost ? undefined : preview
  const [picture, setPicture] = useState<Picture>(() => {
    const found = cache.peek(item, image)
    if (own) return { state: "ready", src: own }
    if (found) return { state: "ready", src: found }
    return found === null || !fetch ? { state: "none" } : { state: "wait" }
  })
  // Only a thumbnail still waiting asks, and once: one that holds a picture or none stays so.
  const waiting = picture.state === "wait" && near && !own
  const { offset, index } = image
  useEffect(() => {
    const ask = asking.current
    if (!waiting || !ask) return
    let current = true
    cache.load(item, { offset, index, mime: null }, ask).then(
      (src) => current && setPicture(src ? { state: "ready", src } : { state: "none" }),
      () => current && setPicture({ state: "none" }),
    )
    return () => {
      current = false
    }
  }, [cache, item, offset, index, waiting])
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const src = picture.state === "ready" ? picture.src : undefined
  // This window's own preview may have been let go of since it was drawn, which the viewer would
  // show as nothing: it is tried first, and the picture asked for instead if it is gone.
  const lose = (): void => {
    setLost(true)
    setPicture({ state: "wait" })
  }
  const show = async (shown: string): Promise<void> => {
    if (shown === own) {
      const here = await globalThis.fetch(shown).then(
        () => true,
        () => false,
      )
      if (!here) return lose()
    }
    setOpen(true)
  }
  return (
    <li ref={watch}>
      {src ? (
        <>
          <button
            ref={button}
            type="button"
            className="chat-image nodrag nopan"
            aria-label={`View ${label}`}
            onClick={() => void show(src)}
          >
            <img
              src={src}
              alt={label}
              onError={() => {
                if (src === own) lose()
              }}
            />
          </button>
          <ImageDialog
            open={open}
            src={src}
            label={label}
            id={`${item}:${offset}:${index}`}
            onClose={() => setOpen(false)}
            returnTo={() => button.current}
          />
        </>
      ) : (
        <span
          className="chat-image-none"
          data-state={picture.state}
          {...(picture.state === "wait" && { role: "img", "aria-label": `Loading ${label}` })}
        >
          {picture.state === "wait" ? "" : label}
        </span>
      )}
    </li>
  )
}

/**
 * The images a recorded prompt carried, as thumbnails on its row, like the ones a prompt still on
 * its way shows. Each opens larger in the image viewer the app's companion pane uses.
 */
export const RecordedImages = ({
  item,
  images,
  text,
}: {
  readonly item: string
  readonly images: readonly ChatImage[]
  readonly text: string
}): React.JSX.Element => {
  const { previews } = useContext(ThumbsContext)
  const own = previews(item)
  const labels = labelsOf(text, images.length)
  return (
    <ul className="chat-images" aria-label="Images sent">
      {images.map((image, at) => (
        <Thumb
          key={`${image.offset}:${image.index}`}
          item={item}
          image={image}
          label={labels[at]!}
          preview={own?.length === images.length ? own[at]?.preview || undefined : undefined}
        />
      ))}
    </ul>
  )
}

// Where the image viewer keeps each picture's place, so one opened again opens as it was left.
const kept = createKept<ViewerState>(24)

const Stage = ({
  id,
  src,
  label,
}: {
  readonly id: string
  readonly src: string
  readonly label: string
}): React.JSX.Element => {
  const content = useMemo(() => ({ src, alt: label }), [src, label])
  const { ref } = useViewer(mountImage, { id, label, content, kept })
  return <div ref={ref} className="chat-image-stage" />
}

// A picture larger, in the image viewer, over the chat; Escape or a click outside closes it.
const ImageDialog = ({
  open,
  src,
  label,
  id,
  onClose,
  returnTo,
}: {
  readonly open: boolean
  readonly src: string
  readonly label: string
  readonly id: string
  readonly onClose: () => void
  readonly returnTo: () => HTMLElement | null
}): React.JSX.Element => (
  <Dialog
    open={open}
    onOpenChange={(now) => {
      if (!now) onClose()
    }}
    label={label}
    finalFocusEl={returnTo}
    backdropClassName="overlay chat-image-backdrop"
    positionerClassName="chat-image-positioner"
    className="modal chat-image-dialog"
  >
    <Stage id={id} src={src} label={label} />
    <button
      type="button"
      className="chat-image-close icon-button"
      aria-label="Close image"
      onClick={onClose}
    >
      <X size={16} />
    </button>
  </Dialog>
)
