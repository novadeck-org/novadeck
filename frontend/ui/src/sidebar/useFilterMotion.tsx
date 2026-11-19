import { useCallback, useLayoutEffect, useRef, type RefObject } from "react"

import { planMotion, type Frame } from "./files-motion"

// The rows' motion when the tree is filtered to the kept agents' work, or brought back whole
// (files-motion.ts plans it): web animations of transform and opacity, which the compositor
// runs, on the rows on screen and nothing else. The rows that go are the very elements React
// just took out, put back for the motion in a layer over the view that clips them, inert and
// hidden from the tree: drawing them again would cost a render of every one. Any other change
// to the tree (a folder opened, a scroll, an agent's write) moves nothing, nor anything under
// reduced motion or with no web animations, as in jsdom.

const moveMs = 200
const leaveMs = 120
const enterMs = 160
const enterDelayMs = 80
// --ease-interface (theme/base.css).
const easing = "cubic-bezier(0.2, 0, 0, 1)"

const canAnimate = (): boolean =>
  typeof Element.prototype.animate === "function" &&
  typeof matchMedia === "function" &&
  !matchMedia("(prefers-reduced-motion: reduce)").matches

// The slots under `parent`, by their data-line.
const slotsIn = (parent: Element): Map<string, HTMLElement> => {
  const slots = new Map<string, HTMLElement>()
  for (const child of parent.children)
    if (child instanceof HTMLElement && child.dataset["line"] !== undefined)
      slots.set(child.dataset["line"], child)
  return slots
}

export const useFilterMotion = ({
  tree,
  rows,
  filter,
  lineOf,
  viewport,
}: {
  // The scrolling tree, and the box of its rows, whose slots carry data-line.
  tree: HTMLElement | null
  rows: HTMLElement | null
  // What the tree is filtered by; the rows move when it changes.
  filter: string
  // Every line's place by its key.
  lineOf: ReadonlyMap<string, number>
  viewport: number | undefined
}): RefObject<HTMLDivElement | null> => {
  // The layer the rows that go are put in, a `.files-ghosts` the panel draws empty.
  const ghosts = useRef<HTMLDivElement>(null)
  const last = useRef<{
    filter: string
    lineOf: ReadonlyMap<string, number>
    slots: ReadonlyMap<string, HTMLElement>
  } | null>(null)
  // Where the tree was last scrolled: read as it scrolls, so a filter that shrinks the tree,
  // which the browser clamps the scroll for, knows where it was before.
  const scrolled = useRef(0)
  // The motion running, if one is; it ends once all of it has finished, or another starts.
  const running = useRef<readonly Animation[]>([])
  const stop = useCallback((): void => {
    const animations = running.current
    running.current = []
    for (const animation of animations) animation.cancel()
    const layer = ghosts.current
    if (!layer) return
    layer.replaceChildren()
    layer.style.height = "0px"
  }, [])
  useLayoutEffect(() => {
    if (!tree) return undefined
    scrolled.current = tree.scrollTop
    const read = (): void => {
      scrolled.current = tree.scrollTop
    }
    tree.addEventListener("scroll", read, { passive: true })
    return () => tree.removeEventListener("scroll", read)
  }, [tree])
  useLayoutEffect(() => stop, [stop])
  // After every draw, the slots drawn, to know the frame before a filter.
  useLayoutEffect(() => {
    if (!rows) return
    const before = last.current
    const slots = slotsIn(rows)
    last.current = { filter, lineOf, slots }
    if (!before || before.filter === filter) return
    stop()
    const layer = ghosts.current
    if (!tree || !layer || viewport === undefined || !canAnimate()) return
    // Reading the scroll lays out the tree as filtered, which the paint does anyway.
    const scrollTop = tree.scrollTop
    const was: Frame = {
      scrollTop: scrolled.current,
      lineOf: before.lineOf,
      drawn: [...before.slots.keys()],
    }
    const now: Frame = { scrollTop, lineOf, drawn: [...slots.keys()] }
    scrolled.current = scrollTop
    const plan = planMotion(was, now, viewport)
    const animations: Animation[] = []
    for (const { key, from } of plan.moves)
      animations.push(
        slots.get(key)!.animate([{ transform: `translateY(${from}px)` }, { transform: "none" }], {
          duration: moveMs,
          easing,
        }),
      )
    for (const key of plan.entering)
      animations.push(
        slots.get(key)!.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: enterMs,
          delay: enterDelayMs,
          easing: "ease-out",
          fill: "backwards",
        }),
      )
    layer.style.top = `${scrollTop}px`
    layer.style.height = `${viewport}px`
    for (const { key, top, shift } of plan.leaving) {
      const slot = before.slots.get(key)
      if (!slot || slot.isConnected) continue
      slot.style.top = `${top}px`
      layer.append(slot)
      animations.push(
        shift === undefined
          ? slot.animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: leaveMs,
              easing: "ease-out",
              fill: "forwards",
            })
          : slot.animate([{ transform: "none" }, { transform: `translateY(${shift}px)` }], {
              duration: moveMs,
              easing,
              fill: "forwards",
            }),
      )
    }
    running.current = animations
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (running.current === animations) stop()
    })
  })
  return ghosts
}
