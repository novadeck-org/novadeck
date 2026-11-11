import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"

import { growHeading, motionMs, reducedMotion, returnFiles, shrinkHeading } from "./motion"
import { stampOf, type TreeFile } from "./tree"
import type { ChangesView } from "./view-state"

// Drilling into a file and back out of it, as the person does it and as it looks: the row
// grows into the file's heading and shrinks back into its row, the files are given back
// scrolled where they were, the keys move only for what the person did (opened, stepped, went
// back), never as a change is read again, and a file that left the selection is closed.

// Which view is moving to which: the row growing into the heading, or the heading shrinking
// into its row.
export type Phase =
  | { readonly kind: "opening"; readonly from: DOMRect }
  | { readonly kind: "closing"; readonly file: TreeFile }

export const useDrillDown = (
  order: readonly TreeFile[],
  view: ChangesView,
  update: (change: (view: ChangesView) => ChangesView) => void,
): {
  readonly host: RefObject<HTMLDivElement | null>
  readonly head: RefObject<HTMLElement | null>
  readonly list: RefObject<HTMLDivElement | null>
  readonly phase: Phase | null
  /** The file open, if it is among the files. */
  readonly opened: TreeFile | undefined
  readonly open: (path: string) => void
  readonly back: () => void
  readonly step: (delta: number) => void
} => {
  const opened = view.open === null ? undefined : order.find((file) => file.path === view.open)
  const host = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase | null>(null)
  // The path of the file last opened, whose row takes the keys back once its file closes.
  const lastOpened = useRef<string | undefined>(undefined)
  // Where the files were scrolled to when one was opened, which the list is given back.
  const scrolled = useRef(0)
  // Keys move only for what the person did (opened, stepped, went back), never as a change is read again.
  const wantFocus = useRef(false)

  const rowOf = useCallback(
    (path: string): HTMLElement | null =>
      [...(host.current?.querySelectorAll<HTMLElement>(".diff-file") ?? [])].find(
        (row) => row.dataset.path === path,
      ) ?? null,
    [],
  )

  const open = useCallback(
    (path: string) => {
      const file = order.find((each) => each.path === path)
      if (!file) return
      const from = rowOf(path)?.getBoundingClientRect()
      scrolled.current = host.current?.querySelector<HTMLElement>(".changes-scroll")?.scrollTop ?? 0
      wantFocus.current = true
      update((now) => ({
        ...now,
        open: path,
        unfolded: path,
        read: { ...now.read, [path]: stampOf(file) },
      }))
      setPhase(from && !reducedMotion() ? { kind: "opening", from } : null)
    },
    [order, rowOf, update],
  )

  const back = useCallback(() => {
    wantFocus.current = true
    update((now) => ({ ...now, open: null }))
    setPhase(opened && !reducedMotion() ? { kind: "closing", file: opened } : null)
  }, [opened, update])

  const step = useCallback(
    (delta: number) => {
      const at = order.findIndex((file) => file.path === view.open)
      const next = order[at + delta]
      if (!next) return
      wantFocus.current = true
      update((now) => ({
        ...now,
        open: next.path,
        unfolded: next.path,
        read: { ...now.read, [next.path]: stampOf(next) },
      }))
    },
    [order, update, view.open],
  )

  // The row grows into the heading; the pane takes the keys.
  useLayoutEffect(() => {
    if (phase?.kind !== "opening" || !head.current) return
    const section = head.current.closest<HTMLElement>(".changes-view")
    if (section) growHeading(section, head.current, phase.from)
    const timer = setTimeout(() => setPhase(null), motionMs)
    return () => clearTimeout(timer)
  }, [phase])
  // The files are back where they were scrolled to, before anything is measured.
  const wasOpen = useRef(false)
  useLayoutEffect(() => {
    if (!opened && wasOpen.current) {
      const scroller = host.current?.querySelector<HTMLElement>(".changes-scroll")
      if (scroller) scroller.scrollTop = scrolled.current
    }
  }, [opened])
  // The heading shrinks into its row once the files are back.
  useLayoutEffect(() => {
    if (phase?.kind !== "closing") return
    const row = rowOf(phase.file.path)
    const section = head.current?.closest<HTMLElement>(".changes-view")
    if (!row || !head.current || !section) {
      setPhase(null)
      return
    }
    returnFiles(list.current ?? row, row)
    let live = true
    void shrinkHeading(section, head.current, row.getBoundingClientRect()).then(() => {
      if (live) setPhase(null)
    })
    return () => {
      live = false
    }
  }, [phase, rowOf])
  // Keys go to the pane while a file is open, and back to its row once it closes.
  useEffect(() => {
    const focus = wantFocus.current
    wantFocus.current = false
    if (opened) {
      if (focus) host.current?.focus({ preventScroll: true })
      lastOpened.current = opened.path
    } else if (wasOpen.current && view.open === null && focus) {
      const path = lastOpened.current
      const row = path === undefined ? null : rowOf(path)
      // The row in view, then the keys; a row not drawn (in a folded folder) leaves them to the pane.
      row?.scrollIntoView?.({ block: "nearest" })
      const button = row?.querySelector<HTMLElement>("button")
      ;(button ?? host.current)?.focus({ preventScroll: true })
    }
    wasOpen.current = opened !== undefined
  }, [opened, rowOf, view.open])
  // A file that is no longer among the selection's is no longer open.
  useEffect(() => {
    if (view.open !== null && !opened) update((now) => ({ ...now, open: null }))
  }, [opened, update, view.open])

  return { host, head, list, phase, opened, open, back, step }
}
