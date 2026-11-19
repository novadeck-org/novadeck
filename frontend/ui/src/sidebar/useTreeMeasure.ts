import { useLayoutEffect, useState } from "react"

import { forgetWidths, fontsOf, noFonts, sameFonts, type Fonts } from "./files-fonts"

// The tree's width and the fonts, which decide how many chips a row has room for, and its height,
// which decides how many rows are drawn; the sidebar is resizable, so a ResizeObserver follows
// the size. Unknown (nothing folds, no rows drawn) until measured, and while the panel is hidden
// (a size of zero). The fonts are read from the rows drawn, so they are read again once there are some, and the chips' once they are.
export const useTreeMeasure = (
  tree: HTMLElement | null,
  drawn: number,
): {
  readonly width: number | undefined
  readonly height: number | undefined
  readonly fonts: Fonts
} => {
  const [width, setWidth] = useState<number | undefined>()
  const [height, setHeight] = useState<number | undefined>()
  const [fonts, setFonts] = useState<Fonts>(noFonts)
  useLayoutEffect(() => {
    const element = tree
    if (!element) return undefined
    const measure = (): void => {
      setWidth(element.clientWidth > 0 ? element.clientWidth : undefined)
      setHeight(element.clientHeight > 0 ? element.clientHeight : undefined)
      const next = fontsOf(element)
      setFonts((known) => (sameFonts(known, next) ? known : next))
    }
    measure()
    let current = true
    const fontsChanged = (): void => {
      if (!current) return
      forgetWidths()
      // The font strings stay the same when a web font loads, but the widths measured before it
      // did not: a new object folds the chips again.
      setFonts(fontsOf(element))
    }
    // A theme sets its own fonts (a mono sans in phosphor) on the root element. Its style also
    // changes for other reasons, as a view's transition, so the measuring waits for the next
    // frame and runs once however many changes came before it.
    const root = typeof document === "undefined" ? undefined : document.documentElement
    let frame: number | undefined
    const themed =
      typeof MutationObserver === "undefined"
        ? undefined
        : new MutationObserver(() => {
            if (!current || frame !== undefined) return
            frame = requestAnimationFrame(() => {
              frame = undefined
              if (current) measure()
            })
          })
    themed?.observe(root!, {
      attributes: true,
      attributeFilter: ["data-theme", "data-scheme", "class", "style"],
    })
    const faces = typeof document === "undefined" ? undefined : document.fonts
    void faces?.ready.then(fontsChanged)
    faces?.addEventListener?.("loadingdone", fontsChanged)
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    return () => {
      current = false
      if (frame !== undefined) cancelAnimationFrame(frame)
      themed?.disconnect()
      faces?.removeEventListener?.("loadingdone", fontsChanged)
      observer?.disconnect()
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Rows drawn have the fonts read again.
  }, [tree, drawn])
  return { width, height, fonts }
}
