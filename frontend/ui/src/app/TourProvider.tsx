import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react"

import { useWorkspaceServices } from "./controller/context"
import { useTour, type TourOffer } from "./useTour"
import { useTourDriver, type TourDriver } from "./useTourDriver"

const OfferContext = createContext<TourOffer | undefined>(undefined)
const DriverContext = createContext<TourDriver | undefined>(undefined)

const always = (): (() => void) => () => {}
const noAgents: readonly never[] = []

/**
 * The tour's one state for the whole app: the offer that the footer's Help menu and the consent
 * dialog share, and the driver that follows a run. They are two contexts, so the footer
 * re-renders as the offer changes and not with each step of a run.
 */
export const TourProvider = ({ children }: { readonly children: ReactNode }): React.JSX.Element => {
  const { backend } = useWorkspaceServices()
  const driver = useTourDriver(backend)
  const connections = useSyncExternalStore(
    backend.agents?.state.subscribe ?? always,
    () => backend.agents?.state.getSnapshot() ?? noAgents,
  )
  const offer = useTour(backend, connections, driver.begin)
  return (
    <DriverContext value={driver}>
      <OfferContext value={offer}>{children}</OfferContext>
    </DriverContext>
  )
}

/** The tour as the app offers it; undefined where the backend has no tour. */
export const useTourOffer = (): TourOffer | undefined => useContext(OfferContext)

/** The run the tour follows now, for its spotlight and closing card. */
export const useTourRun = (): TourDriver => {
  const driver = useContext(DriverContext)
  if (!driver) throw new Error("useTourRun must be used inside a TourProvider")
  return driver
}

/** Whether a tour runs, or its closing card shows; false where there is no tour provider. */
export const useTourBusy = (): boolean => {
  const driver = useContext(DriverContext)
  return driver !== undefined && (driver.shown !== null || driver.closing !== null)
}
