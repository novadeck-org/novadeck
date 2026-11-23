import { useCallback, useEffect, useRef } from "react"

// Files dragged onto the page from a file manager. The zone under the pointer that takes them
// says so while they are over it, and takes them as they are dropped; the innermost zone, so one
// inside another takes them in its place, and one zone at a time. Anywhere else a drop of files
// does nothing: it never leaves the page for the file, as a browser would. A drag with no files
// in it, as of text or a link, stays the page's own.

export type FileDropZone = {
  // Whether it takes files now: asked while they are over it, and again as they are dropped.
  readonly accepts: () => boolean
  // How many files are over it while it takes them (0 where the browser doesn't tell), or null
  // once they are no longer over it: dropped, taken elsewhere, or gone.
  readonly over: (count: number | null) => void
  // Takes the files dropped on it, during the drop: a folder among them is told apart only then.
  readonly drop: (data: DataTransfer) => void
}

type Drag = Event & { readonly dataTransfer?: DataTransfer | null }

const zones = new Map<Element, FileDropZone>()
// The zone that says it takes the files over it now, and the count it was told.
let shown: { readonly zone: FileDropZone; readonly count: number } | undefined
// Set by a dragenter until its task ends: a dragleave that follows one moved within the page,
// as the browser enters where the pointer went before it leaves where it was. Where the browser
// names where it went (`relatedTarget`), that says it instead.
let entering = false
let installed: Window | undefined

const filesIn = (event: Event): DataTransfer | undefined => {
  const data = (event as Drag).dataTransfer
  return data && Array.from(data.types).includes("Files") ? data : undefined
}

const zoneAt = (event: Event): FileDropZone | undefined => {
  for (const node of event.composedPath()) {
    const zone = node instanceof Element ? zones.get(node) : undefined
    if (zone) return zone
  }
  return undefined
}

const show = (next: typeof shown): void => {
  if (shown && shown.zone !== next?.zone) shown.zone.over(null)
  const changed = shown?.zone !== next?.zone || shown?.count !== next?.count
  shown = next
  if (next && changed) next.zone.over(next.count)
}

const hover = (event: Event): void => {
  const data = filesIn(event)
  if (!data) return
  // The browser's own would open the file in place of the page.
  event.preventDefault()
  const zone = zoneAt(event)
  const takes = zone?.accepts() === true
  data.dropEffect = takes ? "copy" : "none"
  const count = Array.from(data.items).filter((item) => item.kind === "file").length
  show(takes && zone ? { zone, count } : undefined)
}

const enter = (event: Event): void => {
  if (!filesIn(event)) return
  entering = true
  setTimeout(() => {
    entering = false
  })
  hover(event)
}

// A frame of its own, as a companion pane's page or PDF: the page hears nothing more of a drag
// that went into one, not even its drop.
const framed = (target: EventTarget | null): boolean =>
  target instanceof Element && target.matches("iframe, frame, webview, object, embed")

const leave = (event: Event): void => {
  if (!filesIn(event)) return
  const to = (event as MouseEvent).relatedTarget
  // Out of the page, or into a frame; anywhere else in the page, its dragover says.
  if (framed(to) || (to === null && !entering)) show(undefined)
}

const drop = (event: Event): void => {
  const data = filesIn(event)
  if (!data) return
  event.preventDefault()
  const zone = zoneAt(event)
  show(undefined)
  if (zone?.accepts()) zone.drop(data)
}

const end = (): void => show(undefined)

// Takes files dragged anywhere on the page from here on, so a drop off every zone does nothing.
// Once per page; zones install it too.
export const guardFileDrops = (page: Window = window): void => {
  if (installed === page) return
  installed = page
  page.addEventListener("dragenter", enter, true)
  page.addEventListener("dragover", hover, true)
  page.addEventListener("dragleave", leave, true)
  page.addEventListener("drop", drop, true)
  page.addEventListener("dragend", end, true)
}

// Makes `element` a zone that takes dropped files, until the returned undo.
export const fileDropZone = (element: Element, zone: FileDropZone): (() => void) => {
  guardFileDrops(element.ownerDocument.defaultView ?? window)
  zones.set(element, zone)
  return () => {
    if (zones.get(element) === zone) zones.delete(element)
    if (shown?.zone !== zone) return
    shown = undefined
    zone.over(null)
  }
}

// A ref that makes the element it is given a zone (`fileDropZone`), until it is given another or
// none. The zone's functions are read as they are called, so they may change on every render.
export const useFileDrop = (zone: FileDropZone): ((element: Element | null) => void) => {
  const latest = useRef(zone)
  useEffect(() => {
    latest.current = zone
  })
  const undo = useRef<(() => void) | undefined>(undefined)
  return useCallback((element: Element | null) => {
    undo.current?.()
    undo.current = element
      ? fileDropZone(element, {
          accepts: () => latest.current.accepts(),
          over: (count) => latest.current.over(count),
          drop: (data) => latest.current.drop(data),
        })
      : undefined
  }, [])
}
