import { Check, Circle, X } from "lucide-react"
import type { ReactNode } from "react"
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react"

import { focusTerminalInput } from "../interaction/dom"
import type { Store } from "../model/store"
import type { Workspace } from "../model/types"
import { projectStatuses } from "../projects/project-status"
import { unreadEnd } from "../terminals/unread-state"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { currentState, shallowEqual } from "./selectors"
import { done, hints, noticed, openedMarked, type Seen } from "./visitor-hints"

// Where a visitor gets the app.
const downloadUrl = "https://novadeck.dev"

const Download = ({ className }: { readonly className: string }): React.JSX.Element => (
  <a className={className} href={downloadUrl} target="_blank" rel="noopener noreferrer">
    Download Novadeck
  </a>
)

// A slim strip above the header on a visitor build: it says the agents are simulated, and
// where to get the real app. Part of the page's column, so it covers nothing.
export const VisitorBar = (): React.JSX.Element | null => {
  const { backend } = useWorkspaceServices()
  if (!backend.visitor) return null
  return (
    <div className="visitor-bar flex shrink-0 items-center justify-between gap-3 px-3 text-caption">
      <p className="m-0 min-w-0 truncate">
        <strong className="visitor-bar-mark font-medium">Demo</strong>
        <span aria-hidden="true"> · </span>
        agents are simulated
      </p>
      <Download className="visitor-download shrink-0 font-medium" />
    </div>
  )
}

// The things to try, as a small card that ticks each off and can be dismissed.
export const VisitorHints = (): React.JSX.Element | null => {
  const { backend } = useWorkspaceServices()
  const answered = backend.visitor?.answered
  if (!answered) return null
  return <Hints answered={answered} />
}

// What the card showed, kept per backend: the app unmounts in a narrow window and the person
// should find the tour as they left it.
const remembered = new WeakMap<object, { seen: ReadonlySet<Seen>; open: boolean }>()

const Hints = ({ answered }: { readonly answered: Store<boolean> }): React.JSX.Element | null => {
  const { workspace: store } = useWorkspaceServices()
  const unread = useUiState((state) => state.unread)
  const view = useWorkspaceState((workspace) => currentState(workspace).view)
  const companion = useWorkspaceState((workspace) =>
    Object.values(currentState(workspace).bars).some((bar) => bar.open),
  )
  const project = useWorkspaceState((workspace) => workspace.activeProjectId)
  // The switcher's marks, as `HeaderSection` computes them.
  const statuses = useWorkspaceState(
    useCallback(
      (workspace: Workspace) =>
        projectStatuses(workspace.projects, (context, id) => unreadEnd(unread, context, id)),
      [unread],
    ),
    shallowEqual,
  )
  const replied = useSyncExternalStore(answered.subscribe, answered.getSnapshot, () => false)
  const titleId = useId()
  // The project on screen and the marks the switcher showed just before this render: the
  // person's mark is the one that was there when they opened a project, not what it shows
  // once they are in it.
  const [before, setBefore] = useState({ project, statuses })
  const [seen, setSeen] = useState<ReadonlySet<Seen>>(
    () => remembered.get(answered)?.seen ?? new Set(),
  )
  const [announcement, setAnnouncement] = useState("")
  const [open, setOpen] = useState(() => remembered.get(answered)?.open ?? true)
  useEffect(() => {
    remembered.set(answered, { seen, open })
  }, [answered, seen, open])
  if (before.project !== project || before.statuses !== statuses) setBefore({ project, statuses })
  // What the person did so far, kept as it shows now.
  const now = noticed(seen, {
    answered: replied,
    view,
    companion,
    marked: openedMarked(before.statuses, before.project, project),
  })
  if (now !== seen) {
    setSeen(now)
    const ticked = hints.filter((hint) => done(hint, now) && !done(hint, seen))
    if (ticked.length)
      setAnnouncement(
        `Done: ${ticked.map((hint) => hint.text).join(" ")}${
          hints.every((hint) => done(hint, now)) ? " That's the tour." : ""
        }`,
      )
  }
  if (!open) return null
  const finished = hints.every((hint) => done(hint, seen))
  // Leaves focus on the terminal the person was in, or the strip's link, rather than
  // dropping it to the page as the card unmounts.
  const dismiss = (): void => {
    setOpen(false)
    const snapshot = store.getSnapshot()
    const terminal = currentState(snapshot).selected
    if (terminal && focusTerminalInput(terminal)) return
    document.querySelector<HTMLElement>(".visitor-bar .visitor-download")?.focus()
  }
  return (
    <section
      className="visitor-hints card fixed right-3 z-30 w-72 p-3"
      aria-labelledby={titleId}
      // Plain Escape dismisses it; with Shift it goes on to the workspace.
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.shiftKey) return
        event.preventDefault()
        event.stopPropagation()
        dismiss()
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={titleId} className="visitor-hints-title m-0 text-control font-medium">
          {finished ? "That's the tour" : "Things to try"}
        </h2>
        <button
          className="icon-button small"
          aria-label="Dismiss the things to try"
          onClick={dismiss}
        >
          <X size={14} />
        </button>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <ul className="visitor-hints-list m-0 mt-2 flex flex-col gap-1.5 p-0 text-control">
        {hints.map((hint) => {
          const ticked = done(hint, seen)
          return (
            <li key={hint.id} className="visitor-hint flex items-start gap-2" data-done={ticked}>
              {ticked ? (
                <Check aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
              ) : (
                <Circle aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
              )}
              <span>
                {hint.text}
                {ticked && <span className="sr-only"> (done)</span>}
              </span>
            </li>
          )
        })}
      </ul>
      {finished && <Download className="button primary visitor-hints-download mt-3" />}
    </section>
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
// room to lay out, shows the panel instead of the app. The app is not mounted at all, so
// nothing of it can be reached, and what it kept in its stores waits for the window to
// widen: a dialog the address names opens again.
export const VisitorCover = ({ children }: { readonly children: ReactNode }): ReactNode => {
  const { backend, workspace } = useWorkspaceServices()
  const narrow = useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(narrowQuery).matches,
    () => false,
  )
  const covered = backend.visitor !== undefined && narrow
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
