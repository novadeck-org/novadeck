import { useLayoutEffect, useRef } from "react"
import type { Location, NavigateFunction, NavigationType } from "react-router"

import { syncLocation, type NavigatorServices, type RouterBinding } from "../commands/navigator"
import { routeUrl } from "../routing"
import type { UiState } from "../ui-store"
import { useStoreSelector } from "./useStoreSelector"

export type RouterState = {
  readonly location: Location
  readonly navigationType: NavigationType
  readonly navigate: NavigateFunction
}

export const dialogDepthOf = (state: unknown): number =>
  (state as { dialogDepth?: number } | null)?.dialogDepth ?? 0

const selectEnabledViews = (state: UiState) => state.preferences.enabledViews

// The one place the URL enters the stores. Locations the navigator did not produce
// (Back/Forward, typed URLs, preference changes) are reconciled against the latest
// workspace in a layout effect, and a URL that names something unavailable is
// replaced with the route the app renders.
export const useRouteSync = (
  sync: NavigatorServices & RouterBinding,
  { location, navigationType, navigate }: RouterState,
): void => {
  useLayoutEffect(() => sync.bind(navigate), [sync, navigate])
  const enabledViews = useStoreSelector(sync.ui, selectEnabledViews)
  const input = `${location.key}:${location.pathname}${location.search}:${enabledViews.join(",")}`
  const committed = useRef(input)
  useLayoutEffect(() => {
    if (committed.current !== input) {
      committed.current = input
      syncLocation(sync, {
        location,
        navigationType,
        dialogDepth: dialogDepthOf(location.state),
      })
    }
    const url = routeUrl(sync.ui.getSnapshot().location.route)
    sync.settle(url)
    if (`${location.pathname}${location.search}` !== url)
      void navigate(url, { replace: true, state: location.state })
  }, [input, location, navigationType, navigate, sync])
}
