import { webglContextsOf, type DesktopApp } from "@novadeck/protocol/bridge"
import {
  configurePageRendererPool,
  pageRendererPool,
  reportRendererPool,
} from "@novadeck/terminal-views/renderer-pool"

// The page's WebGL pool as the desktop app sees it: sized to the contexts the app allows,
// and reported to the app's log.

// Sizes the page's WebGL pool to the limit the app raised, where it says it did. A browser,
// and an app that came before it, keep the pool's default.
export const sizePoolTo = (app: DesktopApp | undefined): void => {
  const contexts = webglContextsOf(app?.webglContexts)
  if (contexts === undefined) return
  // A pool that already exists keeps its limit: starting with it beats not starting.
  try {
    configurePageRendererPool({ contexts })
  } catch (error) {
    console.error("Novadeck could not size the WebGL pool to the app's limit:", error)
  }
}

// Has the app log how the page's WebGL pool fares, where the app takes the report.
export const reportPoolTo = (
  app: DesktopApp | undefined,
  pool: Parameters<typeof reportRendererPool>[0] = pageRendererPool(),
): void => {
  const report = app?.reportRendererPool
  if (report) reportRendererPool(pool, (stats) => report(stats))
}
