import { useLayoutEffect, useRef, useState } from "react"
import { flushSync } from "react-dom"

import { rowHeight } from "./files-window"

// How far the tree is scrolled, in whole rows: a scroll draws again only when it crosses a row,
// and the rows drawn past the edge cover the rest. The draw is synchronous, so a jump past those
// rows (a dragged scrollbar) paints the rows it lands on. Back at the top when the tree is a new
// one.
export const useTreeScroll = (
  tree: HTMLElement | null,
): { readonly top: number; readonly set: (top: number) => void } => {
  const [top, setTop] = useState(0)
  const known = useRef(0)
  useLayoutEffect(() => {
    if (!tree) return undefined
    known.current = Math.floor(tree.scrollTop / rowHeight) * rowHeight
    setTop(known.current)
    const read = (): void => {
      const next = Math.floor(tree.scrollTop / rowHeight) * rowHeight
      if (next === known.current) return
      known.current = next
      flushSync(() => setTop(next))
    }
    tree.addEventListener("scroll", read, { passive: true })
    return () => tree.removeEventListener("scroll", read)
  }, [tree])
  return {
    top,
    set: (next) => {
      known.current = next
      setTop(next)
    },
  }
}
