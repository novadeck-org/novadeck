import type { AgentName } from "@novadeck/core/harnesses"
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import type { TourStarted } from "./start"
import type { TourHost } from "./tour-host"
import { tourKept } from "./tour-storage"
import { useTour, type TourOffer } from "./useTour"
import type { TourDriver } from "./useTourDriver"

// The run's machinery (its steps, signals and driver) loads only when a run begins or one was
// kept, so a page with no tour running carries none of it.
const TourDriverHost = lazy(() => import("./TourDriverHost"))

const OfferContext = createContext<TourOffer | undefined>(undefined)
const DriverContext = createContext<TourDriver | undefined>(undefined)
// Whether a run is on its way: begun, or kept through a reload, with its machinery still loading.
const LoadingContext = createContext(false)

const always = (): (() => void) => () => {}
const noAgents: readonly never[] = []
const nothing = (): void => {}

// The driver while no run is followed, or before the machinery has loaded: it shows nothing.
const idle = (begin: TourDriver["begin"]): TourDriver => ({
  begin,
  shown: null,
  closing: null,
  retryKeep: nothing,
  end: nothing,
  close: nothing,
  back: nothing,
})

/**
 * The tour's one state for the whole app: the offer that the footer's Help menu and the consent
 * dialog share, and the driver that follows a run. They are two contexts, so the footer
 * re-renders as the offer changes and not with each step of a run. The driver is idle until a run
 * begins (or one kept through a reload is found), when its machinery loads.
 */
export const TourProvider = ({
  host,
  children,
}: {
  readonly host: TourHost
  readonly children: ReactNode
}): React.JSX.Element => {
  const { backend } = host
  // Whether the machinery is wanted, and the run to begin when it has loaded.
  const [wanted, setWanted] = useState(tourKept)
  const [live, setLive] = useState<TourDriver | null>(null)
  const [starting, setStarting] = useState<{
    readonly agent: AgentName
    readonly started: TourStarted
  } | null>(null)
  const begin = useCallback(
    (agent: AgentName, started: TourStarted): void => {
      if (live) return live.begin(agent, started)
      setStarting({ agent, started })
      setWanted(true)
    },
    [live],
  )
  const started = useCallback(() => setStarting(null), [])
  const driver = useMemo(() => live ?? idle(begin), [live, begin])
  const connections = useSyncExternalStore(
    backend.agents?.state.subscribe ?? always,
    () => backend.agents?.state.getSnapshot() ?? noAgents,
  )
  const offer = useTour(host, connections, begin)
  return (
    <DriverContext value={driver}>
      <LoadingContext value={wanted && live === null}>
        <OfferContext value={offer}>{children}</OfferContext>
      </LoadingContext>
      {wanted && (
        <Suspense fallback={null}>
          <TourDriverHost host={host} start={starting} onStarted={started} onDriver={setLive} />
        </Suspense>
      )}
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

/**
 * Whether a tour runs, is about to (its machinery still loading), or its closing card shows;
 * false where there is no tour provider.
 */
export const useTourBusy = (): boolean => {
  const driver = useContext(DriverContext)
  const loading = useContext(LoadingContext)
  return loading || (driver !== undefined && (driver.shown !== null || driver.closing !== null))
}
