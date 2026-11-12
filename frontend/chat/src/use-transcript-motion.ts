import { useLayoutEffect, useRef, type RefObject } from "react"

// Only rows appended after the last row already drawn enter. Reading older history and
// opening a folded tool list establish their own baseline, rather than replaying arrivals.
const rowsOf = (list: Element): Element[] =>
  Array.from(list.children).filter((row) =>
    row.matches(".chat-message, .chat-tools, .chat-subagent, .chat-note, .chat-echo, .chat-tool"),
  )

export const useTranscriptMotion = (
  thread: RefObject<HTMLDivElement | null>,
  session: string | null,
  loaded: boolean,
): void => {
  const previous = useRef<{
    session: string | null
    loaded: boolean
    lists: Map<Element, Element[]>
    turns: ReadonlySet<string>
  } | null>(null)
  const running = useRef(new Set<Animation>())

  useLayoutEffect(() => {
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)")
    const cancel = (): void => {
      for (const animation of running.current) animation.cancel()
      running.current.clear()
    }
    preference?.addEventListener("change", cancel)
    return () => {
      preference?.removeEventListener("change", cancel)
      cancel()
    }
  }, [])

  useLayoutEffect(() => {
    const root = thread.current
    if (!root) return
    const lists = new Map(
      [root, ...root.querySelectorAll(".chat-tools-list")].map((list) => [list, rowsOf(list)]),
    )
    const before = previous.current
    const beforeTurns = before?.session === session ? before.turns : new Set<string>()
    const turns = new Set(beforeTurns)
    root
      .querySelectorAll<HTMLElement>(":scope > [data-turn]")
      .forEach((row) => turns.add(row.dataset.turn!))
    previous.current = { session, loaded, lists, turns }
    if (!before || before.session !== session || !before.loaded || !loaded) return
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return

    const entering = new Set<Element>()
    for (const [list, rows] of lists) {
      const old = before.lists.get(list)
      if (!old) continue
      const last = old.at(-1)
      let boundary = last ? rows.indexOf(last) : -1
      if (last && boundary === -1) {
        // A pending tail gives way to the recorded prompt and its first reply. Anchor to
        // the last surviving row, or the start of a chat that held only pending prompts.
        if (!last.matches("[data-sent]")) continue
        const anchor = old.findLast((row) => rows.includes(row))
        if (!anchor && old.some((row) => !row.matches("[data-sent]"))) continue
        boundary = anchor ? rows.indexOf(anchor) : -1
      }
      for (const row of rows.slice(boundary + 1)) {
        if (!old.includes(row)) entering.add(row)
      }
    }
    for (const row of entering) {
      // A send may have an optimistic row before the real transcript records it. Only
      // the recorded prompt fades, once by its turn id; queued/sending labels stay steady.
      if (row.matches("[data-sent]")) continue
      const turn = (row as HTMLElement).dataset.turn
      if (turn !== undefined && beforeTurns.has(turn)) continue
      // A new tool group enters once, with its rows, not once per nested list as well.
      if ([...entering].some((parent) => parent !== row && parent.contains(row))) continue
      if (typeof row.animate !== "function") continue
      // Opacity leaves the geometry used by scroll-follow and pinned prompts untouched.
      const animation = row.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 180,
        easing: "ease-out",
      })
      running.current.add(animation)
      const forget = (): void => {
        running.current.delete(animation)
      }
      animation.addEventListener("finish", forget, { once: true })
      animation.addEventListener("cancel", forget, { once: true })
    }
  })
}
