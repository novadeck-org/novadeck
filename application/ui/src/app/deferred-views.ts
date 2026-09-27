import { lazy } from "react"

export const Grid = lazy(() =>
  import("../layouts/grid/Grid").then((module) => ({ default: module.Grid })),
)
export const Canvas = lazy(() =>
  import("../layouts/canvas/Canvas").then((module) => ({ default: module.Canvas })),
)
export const Preferences = lazy(() =>
  import("../preferences/Preferences").then((module) => ({ default: module.Preferences })),
)
export const TerminalSearch = lazy(() =>
  import("../search/TerminalSearch").then((module) => ({ default: module.TerminalSearch })),
)
