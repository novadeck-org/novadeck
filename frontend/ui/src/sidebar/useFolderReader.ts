import type { SourceListing } from "@novadeck/core/source"
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react"

import { sameRead, type FolderRead, type Listings } from "./source-tree"

// How long a folder may take to read before the panel says it can't.
export const readTimeoutMs = 15_000

// Reads a folder into `setListings`, one read of it at a time: asked again while one is out, it
// runs once more as that lands. A read that never answers is given up on, so its folder isn't
// stuck.
export const useFolderReader = (
  list: (folder: string) => Promise<SourceListing>,
  setListings: Dispatch<SetStateAction<Listings>>,
): { readonly read: (folder: string) => void; readonly isReading: (folder: string) => boolean } => {
  const alive = useRef(true)
  const reading = useRef(new Set<string>())
  const again = useRef(new Set<string>())
  const timeouts = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => {
    alive.current = true
    const pending = timeouts.current
    const busy = reading.current
    const queued = again.current
    return () => {
      alive.current = false
      pending.forEach(clearTimeout)
      pending.clear()
      // A strict remount starts its reads over, which a read out from before must not hold off.
      busy.clear()
      queued.clear()
    }
  }, [])
  const read = useCallback(
    function read(folder: string): void {
      if (reading.current.has(folder)) {
        again.current.add(folder)
        return
      }
      reading.current.add(folder)
      let settled = false
      const settle = (result: FolderRead): void => {
        if (settled || !alive.current) return
        settled = true
        clearTimeout(timer)
        timeouts.current.delete(timer)
        reading.current.delete(folder)
        setListings((known) =>
          sameRead(known.get(folder), result) ? known : new Map(known).set(folder, result),
        )
        if (again.current.delete(folder)) read(folder)
      }
      const timer = setTimeout(() => settle("failed"), readTimeoutMs)
      timeouts.current.add(timer)
      list(folder).then(settle, () => settle("failed"))
    },
    [list, setListings],
  )
  const isReading = useCallback((folder: string): boolean => reading.current.has(folder), [])
  return { read, isReading }
}
