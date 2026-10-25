import { webglContextsOf, type DesktopHost } from "@novadeck/protocol/bridge"
import { configurePageRenderers } from "@novadeck/terminal-views/renderers"

// Chromium's limit less the two contexts the pool keeps free, as its default does of 16.
export const contextMargin = 2

// Sizes the page's WebGL pool to the limit the host raised, where it says it did. A browser,
// and a host that came before it, keep the pool's default.
export const sizePoolTo = (host: DesktopHost | undefined): void => {
  const contexts = webglContextsOf(host?.webglContexts)
  if (contexts === undefined) return
  // A pool that already exists keeps its cap: starting with it beats not starting.
  try {
    configurePageRenderers({ cap: contexts - contextMargin })
  } catch (error) {
    console.error("Novadeck could not size the WebGL pool to the host's limit:", error)
  }
}
