import {
  agentWorking,
  finishNotice,
  sightTurnEnd,
  type AgentFinish,
  type SeenEnd,
} from "../model/agent-finish"
import { orderedTiles } from "../model/roster"
import { activeProject } from "../model/state"
import { createStore, type MutableStore, type Store } from "../model/store"
import type { PreferencesValue, TerminalMetadata, Workspace } from "../model/types"
import { writePreferences } from "../preferences/preferences-storage"
import { initialShell, resetPresentation, type ShellState } from "../shell/shell-state"
import { writeSidebarCollapsed, writeWindowedView } from "../shell/shell-storage"
import { nextRecent, visibleSwitcher, type RecentSwitcher } from "../terminals/recent"
import type { RenameSession } from "../terminals/rename-state"
import {
  clearUnread,
  keepUnread,
  markUnread,
  noUnread,
  viewUnread,
  type Unread,
  type Viewing,
} from "../terminals/unread-state"
import type { WorkspaceRoute } from "./routing"
import { currentContext, currentState } from "./selectors"

// Presentation state the workspace model does not own. One store per App; it
// starts over on reload apart from the slices persisted below.
export type UiState = {
  // The route the app renders, mirrored from the URL, which stays authoritative.
  readonly location: UiLocation
  readonly preferences: PreferencesValue
  readonly shell: ShellState
  readonly rename: RenameSession | null
  readonly recent: {
    readonly switcher: RecentSwitcher | null
    // Each session's terminals, most recently selected first.
    readonly byContext: Readonly<Record<string, readonly string[]>>
  }
  // The terminal created last, highlighted briefly in its session.
  readonly created: { readonly context: string; readonly id: string } | null
  // A close waiting for the person to confirm it, since a program runs in the terminal.
  readonly closing: { readonly context: string; readonly id: string } | null
  // The person chose "Not now" for this crash loop; it asks again only after the next one.
  readonly crashLoopDismissed: boolean
  // How many crashes the backend reports while its far side keeps crashing; 0 otherwise.
  readonly crashLoop: number
  // Whether the page has the person's focus: its window focused and showing.
  readonly pageFocused: boolean
  // The terminals whose agent finished while the person looked elsewhere.
  readonly unread: Unread
}

export type UiLocation = {
  readonly route: WorkspaceRoute
  // History entries the open dialog added above its background entry.
  readonly dialogDepth: number
  readonly navigationType: "POP" | "PUSH" | "REPLACE"
}

export type UiStore = MutableStore<UiState>

export const createUiStore = (initial: UiState): UiStore => createStore(initial)

// A fresh App's UI: only preferences and the collapsed sidebar come from storage.
export const initialUi = ({
  location,
  preferences,
  sidebarCollapsed = false,
}: {
  location: UiLocation
  preferences: PreferencesValue
  sidebarCollapsed?: boolean
}): UiState => ({
  location,
  preferences,
  shell: initialShell(sidebarCollapsed),
  rename: null,
  recent: { switcher: null, byContext: {} },
  created: null,
  closing: null,
  crashLoopDismissed: false,
  crashLoop: 0,
  pageFocused: true,
  unread: noUnread,
})

export const updateShell = (ui: UiStore, change: (shell: ShellState) => ShellState): void =>
  void ui.update((state) => {
    const shell = change(state.shell)
    return shell === state.shell ? state : { ...state, shell }
  })

// Writes one slice to storage now and again whenever it changes; returns the unsubscribe.
export const persist = <S, T>(
  store: Store<S>,
  select: (state: S) => T,
  write: (value: T) => void,
): (() => void) => {
  let saved = select(store.getSnapshot())
  write(saved)
  return store.subscribe(() => {
    const next = select(store.getSnapshot())
    if (Object.is(next, saved)) return
    saved = next
    write(next)
  })
}

// Every slice that outlives a reload, including the active session's windowed view.
export const persistUi = (ui: Store<UiState>, workspace: Store<Workspace>): (() => void) => {
  const stops = [
    persist(ui, (state) => state.preferences, writePreferences),
    persist(ui, (state) => state.shell.sidebarCollapsed, writeSidebarCollapsed),
    persist(workspace, (snapshot) => currentState(snapshot).windowedView, writeWindowedView),
  ]
  return () => stops.forEach((stop) => stop())
}

// Starts the shell's presentation over in the same commit that changes the session,
// so the first render of the new session already sees it.
export const watchPresentation = (workspace: Store<Workspace>, ui: UiStore): (() => void) => {
  let context = currentContext(workspace.getSnapshot())
  return workspace.subscribe(() => {
    const snapshot = workspace.getSnapshot()
    const next = currentContext(snapshot)
    if (next === context) return
    context = next
    const workspaceSessionId = activeProject(snapshot)!.activeSessionId
    updateShell(ui, (shell) => resetPresentation(shell, workspaceSessionId))
  })
}

const sameIds = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
  a !== undefined && a.length === b.length && a.every((id, index) => id === b[index])

// Keeps the active session's most-recent order current after every workspace commit.
export const trackRecent = (workspace: Store<Workspace>, ui: UiStore): (() => void) => {
  const track = (): void => {
    const snapshot = workspace.getSnapshot()
    const context = currentContext(snapshot)
    const { roster, selected } = currentState(snapshot)
    ui.update((state) => {
      const previous = state.recent.byContext[context]
      const ids = nextRecent(previous ?? [], selected, orderedTiles(roster))
      return sameIds(previous, ids)
        ? state
        : {
            ...state,
            recent: { ...state.recent, byContext: { ...state.recent.byContext, [context]: ids } },
          }
    })
  }
  track()
  return workspace.subscribe(track)
}

// Closes the switcher once a dialog opens or the session changes under it.
export const watchSwitcher = (workspace: Store<Workspace>, ui: UiStore): (() => void) => {
  const check = (): void => {
    const { recent, location } = ui.getSnapshot()
    if (!recent.switcher) return
    const context = currentContext(workspace.getSnapshot())
    if (visibleSwitcher(recent.switcher, context, location.route.dialog)) return
    ui.update((state) => ({ ...state, recent: { ...state.recent, switcher: null } }))
  }
  const stops = [workspace.subscribe(check), ui.subscribe(check)]
  return () => stops.forEach((stop) => stop())
}

// Mirrors the backend's crash count, which the crash-loop dialog, the footer and
// keyboard routing read; a crash loop that ends forgets "Not now", so the next one
// asks again.
export const watchCrashLoop = (crashes: Store<number> | undefined, ui: UiStore): (() => void) => {
  if (!crashes) return () => {}
  const check = (): void => {
    const crashLoop = crashes.getSnapshot()
    ui.update((state) => {
      const crashLoopDismissed = crashLoop > 0 && state.crashLoopDismissed
      return state.crashLoop === crashLoop && state.crashLoopDismissed === crashLoopDismissed
        ? state
        : { ...state, crashLoop, crashLoopDismissed }
    })
  }
  check()
  return crashes.subscribe(check)
}

// A close confirmation belongs to the session it was asked in: leaving that session
// drops it, so it never comes back unasked. So does the terminal going away on its own
// (its shell exits): the dialog stops showing, and a question left behind would still
// hold every shortcut back.
export const watchClosing = (workspace: Store<Workspace>, ui: UiStore): (() => void) =>
  workspace.subscribe(() => {
    const { closing } = ui.getSnapshot()
    if (!closing) return
    const snapshot = workspace.getSnapshot()
    if (
      closing.context !== currentContext(snapshot) ||
      !currentState(snapshot).roster.terminals.some((terminal) => terminal.id === closing.id)
    )
      ui.update((state) => ({ ...state, closing: null }))
  })

// The terminal the person looks at: the selected one of the session on screen, while the
// page has their focus.
export const viewing = (workspace: Workspace, ui: Pick<UiState, "pageFocused">): Viewing => {
  const { selected } = currentState(workspace)
  return ui.pageFocused && selected ? { context: currentContext(workspace), id: selected } : null
}

// Every terminal of every session, by `${context}/${terminalId}`.
const terminalsOf = (workspace: Workspace): Map<string, TerminalMetadata> =>
  new Map(
    workspace.projects.flatMap((project) =>
      project.history.flatMap((session) =>
        session.state.roster.terminals.map(
          (terminal) => [`${project.id}/${session.id}/${terminal.id}`, terminal] as const,
        ),
      ),
    ),
  )

// The session context of a terminal's key in `terminalsOf`.
const contextOf = (key: string, terminal: TerminalMetadata): string =>
  key.slice(0, key.length - terminal.id.length - 1)

// A desktop notification about one terminal, as a backend shows it.
export type FinishNotify = (notice: {
  readonly id: string
  readonly title: string
  readonly body: string
}) => void

// Follows agents finishing (see `sightTurnEnd`): a terminal the person isn't looking at as
// its agent finishes is marked unread, and `notify`, where given and the person wants it,
// shows them one notification for it. The mark clears once they look at that terminal,
// its agent works again, or the terminal goes. What each terminal showed when this started
// is taken in as seen.
export const watchFinishes = (
  workspace: Store<Workspace>,
  ui: UiStore,
  notify?: FinishNotify,
): (() => void) => {
  let previous = workspace.getSnapshot()
  let terminals = new Map<string, TerminalMetadata>()
  const seen = new Map<string, SeenEnd>()
  const setUnread = (change: (unread: Unread) => Unread): void =>
    void ui.update((state) => {
      const unread = change(state.unread)
      return unread === state.unread ? state : { ...state, unread }
    })
  const look = (): void =>
    setUnread((unread) => viewUnread(unread, viewing(workspace.getSnapshot(), ui.getSnapshot())))
  // What changed since the last look: the finishes, and the terminals whose agent works.
  const sight = () => {
    const before = terminals
    terminals = terminalsOf(previous)
    const finished: { key: string; terminal: TerminalMetadata; finish: AgentFinish }[] = []
    const working: string[] = []
    for (const [key, terminal] of terminals) {
      if (before.get(key) === terminal) continue
      const { seen: next, finish } = sightTurnEnd(seen.get(key), terminal)
      seen.set(key, next)
      if (finish) finished.push({ key, terminal, finish })
      if (agentWorking(terminal)) working.push(key)
    }
    for (const key of seen.keys()) if (!terminals.has(key)) seen.delete(key)
    return { finished, working }
  }
  sight()
  const follow = (): void => {
    const snapshot = workspace.getSnapshot()
    if (snapshot.projects === previous.projects) return look()
    previous = snapshot
    const { finished, working } = sight()
    const looking = viewing(snapshot, ui.getSnapshot())
    setUnread((current) => {
      let unread = keepUnread(current, (context, id) => terminals.has(`${context}/${id}`))
      for (const key of working) {
        const terminal = terminals.get(key)!
        unread = clearUnread(unread, contextOf(key, terminal), terminal.id)
      }
      for (const { key, terminal, finish } of finished)
        unread = markUnread(
          unread,
          contextOf(key, terminal),
          terminal.id,
          finish.failed ? "failed" : "done",
          looking,
        )
      return viewUnread(unread, looking)
    })
    if (!notify || !ui.getSnapshot().preferences.notifyFinished) return
    for (const { key, terminal, finish } of finished) {
      const seenNow = looking?.context === contextOf(key, terminal) && looking.id === terminal.id
      if (!seenNow) notify({ id: terminal.id, ...finishNotice(terminal, finish) })
    }
  }
  const stops = [workspace.subscribe(follow), ui.subscribe(look)]
  return () => stops.forEach((stop) => stop())
}
