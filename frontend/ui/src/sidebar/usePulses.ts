import type { SourceProject } from "@novadeck/core/source"
import { useEffect, useRef, useState } from "react"

import { rowShowing, writtenPaths, type SourceRow } from "./source-tree"

// How long a write's pulse plays; the panel clears it by this timer, not by the animation, which
// never ends while the panel is hidden.
export const pulseMs = 1400

// Every write pulses the row showing its file, counted by path so the next one restarts the
// animation. Only a shown panel pulses (a hidden one would replay them all on reopening), the
// panel starts with none, and a timer forgets each pulse once it has played. `end` forgets them
// all, as the panel hides.
export const usePulses = (
  changes: SourceProject["changes"] | undefined,
  rows: readonly SourceRow[],
  open: ReadonlySet<string>,
  showing: boolean,
): { readonly pulses: Readonly<Record<string, number>>; readonly end: () => void } => {
  const [pulses, setPulses] = useState<Readonly<Record<string, number>>>({})
  const [seen, setSeen] = useState(changes)
  if (seen !== changes) {
    setSeen(changes)
    if (seen && changes && showing) {
      const onScreen = new Set(rows.map((row) => row.node.path))
      const written = new Set(
        writtenPaths(seen, changes)
          .map((path) => rowShowing(path, open))
          .filter((path) => onScreen.has(path)),
      )
      if (written.size > 0)
        setPulses((current) => ({
          ...current,
          ...Object.fromEntries([...written].map((path) => [path, (current[path] ?? 0) + 1])),
        }))
    }
  }
  const timers = useRef(new Map<string, { count: number; id: ReturnType<typeof setTimeout> }>())
  useEffect(() => {
    const running = timers.current
    for (const [path, count] of Object.entries(pulses)) {
      const timer = running.get(path)
      if (timer?.count === count) continue
      clearTimeout(timer?.id)
      const id = setTimeout(() => {
        running.delete(path)
        setPulses(({ [path]: _played, ...rest }) => rest)
      }, pulseMs)
      running.set(path, { count, id })
    }
    for (const [path, timer] of running)
      if (!(path in pulses)) {
        clearTimeout(timer.id)
        running.delete(path)
      }
  }, [pulses])
  useEffect(() => {
    const running = timers.current
    return () => {
      for (const timer of running.values()) clearTimeout(timer.id)
      running.clear()
    }
  }, [])
  const end = (): void => {
    if (Object.keys(pulses).length > 0) setPulses({})
  }
  return { pulses, end }
}
