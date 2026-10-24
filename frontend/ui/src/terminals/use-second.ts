import { useEffect, useState } from "react"

// Renders the component again every second while `ticking`, as a wake-up's countdown needs.
export const useSecond = (ticking: boolean): void => {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!ticking) return undefined
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000)
    return () => clearInterval(timer)
  }, [ticking])
}
