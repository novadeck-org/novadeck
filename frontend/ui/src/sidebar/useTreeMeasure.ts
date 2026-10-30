import { useLayoutEffect, useState } from "react"

import { forgetWidths, fontsOf, noFonts, sameFonts, type Fonts } from "./source-fonts"

// The tree's width and the fonts, which decide how many chips a row has room for; the sidebar is
// resizable, so a ResizeObserver follows the width. Unknown (nothing folds) until measured, and
// while the panel is hidden (a width of zero).
export const useTreeMeasure = (
  tree: HTMLElement | null,
): { readonly width: number | undefined; readonly fonts: Fonts } => {
  const [width, setWidth] = useState<number | undefined>()
  const [fonts, setFonts] = useState<Fonts>(noFonts)
  useLayoutEffect(() => {
    const element = tree
    if (!element) return undefined
    const measure = (): void => {
      setWidth(element.clientWidth > 0 ? element.clientWidth : undefined)
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
  }, [tree])
  return { width, fonts }
}
