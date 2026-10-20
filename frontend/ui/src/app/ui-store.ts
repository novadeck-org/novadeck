import {
  agentWorking,
  finishGraceMs,
  finishNotice,
  standingFinish,
  sightTurnEnd,
  type AgentFinish,
  type SeenEnd,
} from "@novadeck/core/agent-finish"
import type { Backend } from "@novadeck/core/port"
import type { PortableState } from "@novadeck/core/portable"
import {
  readPortableCardRaised,
  writePortableCardRaised,
} from "@novadeck/core/portable-card-raised"
import { orderedTiles } from "@novadeck/core/roster"
import type { SandboxState } from "@novadeck/core/sandbox"
import { activeProject } from "@novadeck/core/state"
import { createStore, type MutableStore, type Store } from "@novadeck/core/store"
import type { PreferencesValue, TerminalMetadata, Workspace } from "@novadeck/core/types"
import type { UpdateOffer, WhatsNew } from "@novadeck/core/update"

import { writePreferences } from "../preferences/preferences-storage"
import { noArrangement, type ProjectArrangement } from "../projects/project-arrangement"
import { writeProjectArrangement } from "../projects/project-arrangement-storage"
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
  // Which addon's offer (voice input or murmur) came up in this run of the app: each run
  // offers at most one unasked; never persisted.
  readonly addonOffer: "voice" | "murmur" | null
  // The terminal Murmur's offer chip sits on, by session context and id: the first whose
  // agent finished a turn, until the offer is answered; never persisted.
  readonly nameOffer: { readonly context: string; readonly id: string } | null
  // How many crashes the backend reports while its far side keeps crashing; 0 otherwise.
  readonly crashLoop: number
  // The update the desktop app last told of: downloaded, or to fetch from its release page.
  readonly update: UpdateOffer | null
  // Whether its notice is open, or waits to open once the footer shows.
  readonly portableCardOpen: boolean
  // What is new in the version the app updated to, until the person dismisses it; null
  // while the host has none to show or has not answered yet.
  readonly whatsNew: WhatsNew | null
  // Whether the desktop app runs in its security sandbox, as the host said at startup; null
  // until then, and where it does not say.
  readonly sandbox: SandboxState | null
  // Whether its notice is open. It and the update's share a place, so one open closes the other.
  readonly sandboxOpen: boolean
  // Whether the desktop app is a portable copy, as the host said at startup; null until it
  // has, and where it says nothing.
  readonly portable: PortableState | null
  // Whether the page has the person's focus: its window focused and showing.
  readonly pageFocused: boolean
  // The terminals whose agent finished while the person looked elsewhere.
  readonly unread: Unread
  // How the person arranged the switcher's projects: their order and the pinned ones.
  readonly projectArrangement: ProjectArrangement
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
  projectArrangement = noArrangement,
}: {
  location: UiLocation
  preferences: PreferencesValue
  sidebarCollapsed?: boolean
  projectArrangement?: ProjectArrangement
}): UiState => ({
  location,
  preferences,
  shell: initialShell(sidebarCollapsed),
  rename: null,
  recent: { switcher: null, byContext: {} },
  created: null,
  closing: null,
  crashLoopDismissed: false,
  addonOffer: null,
  nameOffer: null,
  crashLoop: 0,
  update: null,
  portableCardOpen: false,
  whatsNew: null,
  sandbox: null,
  sandboxOpen: false,
  portable: null,
  pageFocused: true,
  unread: noUnread,
  projectArrangement,
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
    persist(ui, (state) => state.projectArrangement, writeProjectArrangement),
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
            recent: {
              ...state.recent,
              byContext: { ...state.recent.byContext, [context]: ids },
            },
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
    ui.update((state) => ({
      ...state,
      recent: { ...state.recent, switcher: null },
    }))
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

// The update the backend offers, kept for the footer; a later offer replaces the last.
// Only a portable copy has a notice, a corner card that comes up by itself once per launch,
// with the offer or without one, and after that only from its footer chip. It waits while
// the footer is hidden. A copy that updates itself raises nothing, as its downloads show as
// a bar. An offer heard before the host says whether this is a portable copy is raised once
// it does (`watchPortable`).
// Once per launch is what the host's run name says, kept beyond the page's life
// (`readPortableCardRaised`, written as the card shows), so a reload, a window opened again or a
// new attempt at the backend does not raise it again, while a card held back does. (The
// demo's boots stand for launches and clear it; the desktop app's retries do not.)
export const watchUpdates = (updates: Backend["updates"], ui: UiStore): (() => void) =>
  updates?.onOffer((update) => {
    const { portable } = ui.getSnapshot()
    const raise = portable?.portable === true && !raisedThisRun(portable)
    ui.update((current) => ({
      ...current,
      update,
      portableCardOpen: current.portableCardOpen || raise,
    }))
  }) ?? (() => {})

// Asks the backend once, as the workspace comes up, what is new in the version the app
// updated to, and keeps the answer for the footer's card. Whether the card is due at all
// (a version updated to, its notes read, not dismissed) is the host's to say: the page
// keeps no memory of its own. A host that fails to answer has nothing to show, and it is
// not asked again before the next launch.
export const watchWhatsNew = (whatsNew: Backend["whatsNew"], ui: UiStore): (() => void) => {
  let live = true
  void whatsNew?.get().then(
    (found) => {
      if (live && found) ui.update((state) => ({ ...state, whatsNew: found }))
    },
    () => undefined,
  )
  return () => {
    live = false
  }
}

// The person dismissed the card: the host remembers, so no later launch offers it again,
// and the card goes.
export const dismissWhatsNew = (whatsNew: Backend["whatsNew"], ui: UiStore): void => {
  whatsNew?.dismiss()
  ui.update((state) => (state.whatsNew ? { ...state, whatsNew: null } : state))
}

// Notes that the portable copy's card showed, for the rest of the run.
export const notePortableCardShown = (portable: PortableState | null): void => {
  if (portable?.portable) writePortableCardRaised(portable.run)
}

// Whether this run of a portable copy has shown its card already.
// A copy whose install has begun or ended has nothing to raise: the card is already up or
// has been.
const raisedThisRun = (portable: PortableState): boolean =>
  portable.portable && (portable.install.phase !== "idle" || readPortableCardRaised(portable.run))

// Asks the backend once whether the app is a portable copy, and keeps the answer for the
// footer. A portable copy raises its card now, offer or not. A host that fails to say is
// taken as not saying. A state the host pushes later (each step of an install) replaces
// it without raising anything, and wins over an answer that comes after it.
export const watchPortable = (portable: Backend["portable"], ui: UiStore): (() => void) => {
  let live = true
  let pushed = false
  const stop = portable?.onState((portableState) => {
    pushed = true
    ui.update((state) => ({ ...state, portable: portableState }))
  })
  void portable?.state().then(
    (portableState) => {
      if (!live || pushed) return
      const raise = portableState.portable && !raisedThisRun(portableState)
      ui.update((state) => ({
        ...state,
        portable: portableState,
        portableCardOpen: state.portableCardOpen || raise,
      }))
    },
    // A host that fails to say is not one, so nothing waits on its answer.
    () => {
      if (live) ui.update((state) => ({ ...state, portable: { portable: false } }))
    },
  )
  return () => {
    live = false
    stop?.()
  }
}

// Asks the backend once whether the app runs in its security sandbox, and keeps the
// answer for the footer. A host that fails to say is taken as not saying.
export const watchSandbox = (sandbox: Backend["sandbox"], ui: UiStore): (() => void) => {
  let live = true
  void sandbox?.().then(
    (state) => {
      if (live) ui.update((current) => ({ ...current, sandbox: state }))
    },
    () => undefined,
  )
  return () => {
    live = false
  }
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
// shows them one notification for it. `unread`, where given, is told each such finish by
// its terminal and the end's `at`, so murmur can write a gist of its reply. The mark clears
// once they look at that terminal, its agent works again, or the terminal goes. `finished`,
// where given, is told each finish that completed (not one that failed), whoever looks at it,
// by the terminal's session context and id. What each terminal showed when this started is
// taken in as seen.
export const watchFinishes = (
  workspace: Store<Workspace>,
  ui: UiStore,
  {
    notify,
    graceMs = finishGraceMs,
    unread: gist,
    finished: completed,
  }: {
    notify?: FinishNotify | undefined
    graceMs?: number
    unread?: ((terminalId: string, at: number) => void) | undefined
    finished?: ((context: string, id: string) => void) | undefined
  } = {},
): (() => void) => {
  let previous = workspace.getSnapshot()
  let terminals = new Map<string, TerminalMetadata>()
  const seen = new Map<string, SeenEnd>()
  const waiting = new Set<ReturnType<typeof setTimeout>>()
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
    const finished: {
      key: string
      terminal: TerminalMetadata
      finish: AgentFinish
    }[] = []
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
    setUnread((current) => {
      let unread = keepUnread(current, (context, id) => terminals.has(`${context}/${id}`))
      for (const key of working) {
        const terminal = terminals.get(key)!
        unread = clearUnread(unread, contextOf(key, terminal), terminal.id)
      }
      return viewUnread(unread, viewing(snapshot, ui.getSnapshot()))
    })
    for (const each of finished) {
      // A completed end waits, in case its harness then says the person's Escape stopped
      // the turn (see `finishGraceMs`); one that failed was there.
      if (each.finish.failed || graceMs <= 0) announce([each])
      else {
        const at = seen.get(each.key)
        const timer = setTimeout(() => {
          waiting.delete(timer)
          const current = terminals.get(each.key)
          const finish =
            current && at !== null && at !== undefined ? standingFinish(current, at) : undefined
          if (current && finish) announce([{ key: each.key, terminal: current, finish }])
        }, graceMs)
        waiting.add(timer)
      }
    }
  }
  // Marks and notifies the finishes, unless the person looks at that terminal.
  const announce = (
    finished: readonly {
      key: string
      terminal: TerminalMetadata
      finish: AgentFinish
    }[],
  ): void => {
    for (const { key, terminal, finish } of finished)
      if (!finish.failed) completed?.(contextOf(key, terminal), terminal.id)
    const looking = viewing(workspace.getSnapshot(), ui.getSnapshot())
    setUnread((current) => {
      let unread = current
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
    const unseen = finished.filter(({ key, terminal }) => {
      const seenNow = looking?.context === contextOf(key, terminal) && looking.id === terminal.id
      return !seenNow
    })
    for (const { terminal } of unseen) {
      const at = terminal.state === "running" ? terminal.agent?.lastTurn?.at : undefined
      if (at !== undefined) gist?.(terminal.id, at)
    }
    if (!notify || !ui.getSnapshot().preferences.notifyFinished) return
    for (const { terminal, finish } of unseen)
      notify({ id: terminal.id, ...finishNotice(terminal, finish) })
  }
  const stops = [workspace.subscribe(follow), ui.subscribe(look)]
  return () => {
    stops.forEach((stop) => stop())
    waiting.forEach(clearTimeout)
  }
}
