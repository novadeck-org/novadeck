import type { Store } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"
import type { ReactNode } from "react"
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react"

import { focusTerminalInput } from "../interaction/dom"
import { useWorkspaceServices } from "./controller/context"
import { useEmbedded } from "./embedded"
import { currentState } from "./selectors"

// Where a visitor gets the app.
const downloadUrl = "https://novadeck.dev/download"

const Download = ({ className }: { readonly className: string }): React.JSX.Element => (
  <a className={className} href={downloadUrl} target="_blank" rel="noopener noreferrer">
    Download Novadeck
  </a>
)

// A slim strip above the header on a visitor build: it says the agents are simulated, and
// where to get the real app. Part of the page's column, so it covers nothing. A page that
// frames the app says so itself. While it shows it says how tall it is as `--visitor-bar-offset`
// on the page, for what sits over the header (the Inbox's toasts) to stay under it.
export const VisitorBar = (): React.JSX.Element | null => {
  const { backend } = useWorkspaceServices()
  const embedded = useEmbedded()
  const bar = useRef<HTMLDivElement>(null)
  const shown = Boolean(backend.visitor) && !embedded
  useLayoutEffect(() => {
    const root = document.documentElement
    if (!shown || !bar.current) return undefined
    root.style.setProperty("--visitor-bar-offset", `${bar.current.offsetHeight}px`)
    return () => void root.style.removeProperty("--visitor-bar-offset")
  }, [shown])
  if (!shown) return null
  return (
    <div
      ref={bar}
      className="visitor-bar flex shrink-0 items-center justify-between gap-3 px-3 text-caption"
    >
      <p className="m-0 min-w-0 truncate">
        <strong className="visitor-bar-mark font-medium">Demo</strong>
        <span aria-hidden="true"> · </span>
        agents are simulated
      </p>
      <Download className="visitor-download shrink-0 font-medium" />
    </div>
  )
}

const narrowQuery = "(max-width: 759px)"

const subscribeNarrow = (notify: () => void): (() => void) => {
  const media = window.matchMedia(narrowQuery)
  media.addEventListener("change", notify)
  return () => media.removeEventListener("change", notify)
}

// The panel that takes the narrow window: it points to a desktop browser, or the download.
const VisitorPhone = (): React.JSX.Element => (
  <main
    className="visitor-phone fixed inset-0 z-100 flex items-center justify-center p-6"
    aria-label="Best on a desktop browser"
  >
    <div className="flex max-w-sm flex-col items-center gap-3 text-center">
      <h2 className="visitor-phone-title m-0 text-title font-medium">Best on a desktop browser</h2>
      <p className="visitor-phone-text m-0 text-body">
        Novadeck lays terminals out in Focus, Grid and Canvas, which needs a window about 760 pixels
        wide. Open this page on a computer to try the demo, where the agents are simulated.
      </p>
      <Download className="button primary visitor-phone-download" />
    </div>
  </main>
)

// Where focus goes when the app comes back: it was lost with the panel, so it returns to
// the selected terminal, or to the strip's link, unless a dialog the address still names
// has taken it.
const refocus = (store: Store<Workspace>, later: (run: () => void) => void, frames = 20): void => {
  if (document.activeElement && document.activeElement !== document.body) return
  const terminal = currentState(store.getSnapshot()).selected
  if (terminal && focusTerminalInput(terminal)) return
  const link = document.querySelector<HTMLElement>(".visitor-bar .visitor-download")
  if (link) link.focus()
  else if (frames > 0) later(() => refocus(store, later, frames - 1))
}

// In a visitor build in a window too narrow for the app, under about 760px where it has no
// room to lay out, shows the panel instead of the app; a page that frames the app decides
// what a narrow window gets itself. The app is not mounted at all, so nothing of it can be
// reached, and what it kept in its stores waits for the window to widen: a dialog the
// address names opens again.
export const VisitorCover = ({ children }: { readonly children: ReactNode }): ReactNode => {
  const { backend, workspace } = useWorkspaceServices()
  const embedded = useEmbedded()
  const narrow = useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(narrowQuery).matches,
    () => false,
  )
  const covered = backend.visitor !== undefined && narrow && !embedded
  const was = useRef(false)
  useEffect(() => {
    if (was.current && !covered) {
      // Every frame still pending is cancelled when the window narrows again.
      const pending = new Set<number>()
      const later = (run: () => void): void => {
        const frame = requestAnimationFrame(() => {
          pending.delete(frame)
          run()
        })
        pending.add(frame)
      }
      // Waits for the app and a dialog to mount and take their own focus.
      later(() => later(() => refocus(workspace, later)))
      was.current = covered
      return () => pending.forEach(cancelAnimationFrame)
    }
    was.current = covered
  }, [covered, workspace])
  return covered ? <VisitorPhone /> : children
}
