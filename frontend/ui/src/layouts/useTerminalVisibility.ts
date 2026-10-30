import { useEffect, useState } from "react"

import { prefersReducedMotion } from "../interaction/reduced-motion"

// Keep exiting cards mounted for the matching terminal-visibility CSS transition.
export const useTerminalVisibility = (hidden: Record<string, boolean>): Record<string, boolean> => {
  const [removed, setRemoved] = useState(hidden)
  const reduced = prefersReducedMotion()
  if (reduced && removed !== hidden) setRemoved(hidden)
  else if (Object.keys(removed).some((id) => removed[id] && !hidden[id])) {
    setRemoved(Object.fromEntries(Object.entries(removed).filter(([id]) => hidden[id])))
  }

  useEffect(() => {
    if (reduced || !Object.keys(hidden).some((id) => hidden[id] && !removed[id])) return
    const timeout = window.setTimeout(() => setRemoved(hidden), 180)
    return () => window.clearTimeout(timeout)
  }, [hidden, reduced, removed])

  return reduced ? hidden : removed
}
