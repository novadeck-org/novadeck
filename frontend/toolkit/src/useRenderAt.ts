import { useEffect, useState } from "react"

// Renders the component again once `at` passes, as when a rate-limit window resets while
// its agent reports nothing new.
export const useRenderAt = (at: number | undefined): void => {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (at === undefined) return undefined
    const timer = setTimeout(() => setTick((tick) => tick + 1), Math.max(0, at - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [at])
}
