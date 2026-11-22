import type { AgentName } from "@novadeck/core/harnesses"
import { useEffect } from "react"

import type { TourStarted } from "./start"
import type { TourHost } from "./tour-host"
import { useTourDriver, type TourDriver } from "./useTourDriver"

/**
 * The tour's run machinery, loaded only once a run begins or one was kept (`TourProvider`): it
 * follows the run, hands the driver up as it changes, and begins the run it was loaded for.
 */
const TourDriverHost = ({
  host,
  start,
  onStarted,
  onDriver,
}: {
  readonly host: TourHost
  // A run the person just started, to begin once this has loaded.
  readonly start: { readonly agent: AgentName; readonly started: TourStarted } | null
  readonly onStarted: () => void
  readonly onDriver: (driver: TourDriver) => void
}): null => {
  const driver = useTourDriver(host)
  useEffect(() => onDriver(driver), [driver, onDriver])
  const { begin } = driver
  useEffect(() => {
    if (!start) return
    begin(start.agent, start.started)
    onStarted()
  }, [start, begin, onStarted])
  return null
}

export default TourDriverHost
