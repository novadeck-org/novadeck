// First, so its `@layer` order statement leads the bundle.
import "@novadeck/ui/styles.css"
import type { Backend, BackendSelection, ConnectBackend } from "@novadeck/core/port"
import { createBootRehearsals } from "@novadeck/demo-debug/boot-rehearsal"
import { App, type WorkspacePanel } from "@novadeck/ui/app/App"
import { start } from "@novadeck/ui/entries/start"
import { pageTheme } from "@novadeck/ui/theme/source"

// The content preview (`pnpm dev:previews`): the demo with its debug panel, both loaded with
// the connection, so no build for a runner carries them.
const rehearsals = createBootRehearsals()

// The panel isn't part of what a backend offers, so the selection that made the backend
// hands it to the app, once the demo has loaded.
let panelOf: ((backend: Backend) => WorkspacePanel | undefined) | undefined

// One connection for every attempt, as it remembers the variant and what the panel armed.
// Attempts at once share its load; one that failed is tried again by the next.
let loading: Promise<ConnectBackend> | undefined
const load = (): Promise<ConnectBackend> =>
  (loading ??= import("@novadeck/demo-debug/connect").then(
    ({ connectDemo, debugPanelOf }) => {
      panelOf = debugPanelOf
      return connectDemo(rehearsals, pageTheme)
    },
    (error: unknown) => {
      loading = undefined
      throw error
    },
  ))

const demo: BackendSelection = {
  connect: async (signal, progress) => (await load())(signal, progress),
  reboots: rehearsals.reboots,
}

start(<App selection={demo} panel={(backend) => panelOf?.(backend)} />)
