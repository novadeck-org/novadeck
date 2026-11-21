import { createElement, lazy, useEffect, useState, type ComponentType } from "react"

// A view whose code loads on first use or ahead of it. Once loaded it renders straight
// away, so a view transition captures the view and not a loading line; before that its
// first mount suspends as usual. The choice holds for the whole mount, so a load
// finishing meanwhile never swaps the component under its terminals.
const deferred = <P extends object>(load: () => Promise<ComponentType<P>>) => {
  let loaded: ComponentType<P> | undefined
  const preload = (): Promise<ComponentType<P>> =>
    load().then((component) => {
      loaded = component
      return component
    })
  const Lazy = lazy(() => preload().then((component) => ({ default: component })))
  const View = (props: P): React.JSX.Element => {
    const [component] = useState<ComponentType<P>>(() => loaded ?? Lazy)
    return createElement(component, props)
  }
  return { View, preload }
}

const grid = deferred(() => import("../layouts/grid/Grid").then((module) => module.Grid))
const canvas = deferred(() => import("../layouts/canvas/Canvas").then((module) => module.Canvas))

export const Grid = grid.View
export const Canvas = canvas.View

// Fetches Grid and Canvas ahead of the first switch to them.
export const preloadViews = (): void => {
  void grid.preload()
  void canvas.preload()
}

export const Preferences = lazy(() =>
  import("../preferences/Preferences").then((module) => ({ default: module.Preferences })),
)
export const TerminalSearch = lazy(() =>
  import("../search/TerminalSearch").then((module) => ({ default: module.TerminalSearch })),
)

// The tour's stage and closing card, with their print look and its font, which only a run of the
// tour draws. A chunk that fails to load is said to the log, and stands in with `failed`: the
// stage ends the run, which would go on unseen and with no way to end it, and the closing card
// puts itself away.
const tourPart = <P extends object>(
  load: () => Promise<ComponentType<P>>,
  failed: ComponentType<P>,
) =>
  lazy(() =>
    load().then(
      (component) => ({ default: component }),
      (error: unknown) => {
        window.reportError(error)
        return { default: failed }
      },
    ),
  )

// Calls `act` once, as its component mounts.
const useOnce = (act: () => void): void => {
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- Once, whatever `act` is by then.
  useEffect(act, [])
}

const EndsTheRun = ({ onEnd }: { readonly onEnd: () => void }): null => {
  useOnce(onEnd)
  return null
}

const PutsItselfAway = ({ onClose }: { readonly onClose: () => void }): null => {
  useOnce(onClose)
  return null
}

export const TourStage = tourPart(
  () => import("@novadeck/tour/Stage").then((module) => module.TourStage),
  EndsTheRun,
)
export const TourClosingCard = tourPart(
  () => import("@novadeck/tour/ClosingCard").then((module) => module.TourClosingCard),
  PutsItselfAway,
)
