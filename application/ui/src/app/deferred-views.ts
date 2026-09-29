import { createElement, lazy, useState, type ComponentType } from "react"

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
