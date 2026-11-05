// First, so its `@layer` order statement leads the bundle.
import "@novadeck/ui/styles.css"
import type { BackendSelection } from "@novadeck/core/port"
import { App } from "@novadeck/ui/app/App"
import { start } from "@novadeck/ui/entries/start"
import { pageTheme } from "@novadeck/ui/theme/source"

import { embeddedIn } from "./embed"
import { reloadOnStaleDeploy } from "./reload"

// The visitor build, for a website: the demo without its debug panel. It loads with the
// connection, so the page's first load carries neither it nor its terminal emulator: the
// build checks that, and holds each part to its budget in vite.config.ts.
const visitor: BackendSelection = {
  connect: async (signal, progress) =>
    (await import("@novadeck/demo/visitor/connect")).connectVisitor(signal, progress, {
      theme: pageTheme,
    }),
}

// A page that outlived a deploy reloads to pick up the new build: see src/reload.ts.
reloadOnStaleDeploy(
  window,
  () => window.sessionStorage,
  () => window.location.reload(),
)

// Whether the page is the hero's frame, read here once, and nowhere else: see src/embed.ts.
start(<App selection={visitor} embedded={embeddedIn(window)} />)
