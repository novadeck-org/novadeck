import { defaultCanvasWindowSize, type WindowSize } from "@novadeck/core/layout/terminal-size"
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
import type { PreferencesValue, Workspace } from "@novadeck/core/types"
import type { UpdateOffer, WhatsNew } from "@novadeck/core/update"

import { writeCanvasWindowSize } from "../layouts/canvas/window-size-storage"
import { writePreferences } from "../preferences/preferences-storage"
import { noArrangement, type ProjectArrangement } from "../projects/project-arrangement"
import { writeProjectArrangement } from "../projects/project-arrangement-storage"
import { initialShell, resetPresentation, type ShellState } from "../shell/shell-state"
import { writeSidebarCollapsed, writeWindowedView } from "../shell/shell-storage"
import { nextRecent, visibleSwitcher, type RecentSwitcher } from "../terminals/recent"
import type { RenameSession } from "../terminals/rename-state"
import { noUnread, type Unread, type Viewing } from "../terminals/unread-state"
import { noFeatureFlags, type FeatureFlag, type FeatureFlags } from "./feature-flags"
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
  // How many new items the Inbox's bell has rung for in this run, as the toast and the OS ping
  // ring them (`watchBellRings`): its dot rings with each; never persisted.
  readonly bellRings: number
  // The terminals with finished turns the person hasn't read: the Inbox's stored rows,
  // mirrored by `watchUnreadTurns`; never persisted.
  readonly unread: Unread
  // How the person arranged the switcher's projects: their order and the pinned ones.
  readonly projectArrangement: ProjectArrangement
  // The size the person last gave a window on Canvas, which new windows open at.
  readonly canvasWindowSize: WindowSize
  // Which of the app's unfinished parts the person turned on; never persisted, as the host
  // remembers them.
  readonly flags: FeatureFlags
}

export type UiLocation = {
  readonly route: WorkspaceRoute
  // History entries the open dialog added above its background entry.
  readonly dialogDepth: number
  readonly navigationType: "POP" | "PUSH" | "REPLACE"
}

export type UiStore = MutableStore<UiState>

export const createUiStore = (initial: UiState): UiStore => createStore(initial)

// A fresh App's UI: only the slices persisted below come from storage.
export const initialUi = ({
  location,
  preferences,
  sidebarCollapsed = false,
  projectArrangement = noArrangement,
  canvasWindowSize = defaultCanvasWindowSize,
}: {
  location: UiLocation
  preferences: PreferencesValue
  sidebarCollapsed?: boolean
  projectArrangement?: ProjectArrangement
  canvasWindowSize?: WindowSize
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
  bellRings: 0,
  unread: noUnread,
  projectArrangement,
  canvasWindowSize,
  flags: noFeatureFlags,
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
    persist(ui, (state) => state.canvasWindowSize, writeCanvasWindowSize),
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

// Whether terminals show their agents' chat: the person turned the chat view on, and it is
// one of the experimental features, so it shows only while IS_EXPERIMENTAL is on.
export const chatViewOn = (state: Pick<UiState, "preferences" | "flags">): boolean =>
  state.flags.IS_EXPERIMENTAL && state.preferences.chatView

// Turns one feature flag on or off, as is: `setFeatureFlag` of the workspace's commands also
// starts terminals afresh on the chat view where the flag turns it on or off.
export const setFeatureFlag = (ui: UiStore, flag: FeatureFlag, on: boolean): void => {
  ui.update((state) =>
    state.flags[flag] === on ? state : { ...state, flags: { ...state.flags, [flag]: on } },
  )
}

// Asks the backend once, as the workspace comes up, whether the desktop app follows early
// builds, which is what turns IS_EXPERIMENTAL on, through `set`. A host that fails to say
// leaves it off.
export const watchExperimental = (
  updates: Backend["updates"],
  set: (on: boolean) => void,
): (() => void) => {
  let live = true
  void updates?.channel?.get().then(
    (channel) => {
      if (live) set(channel === "early")
    },
    () => undefined,
  )
  return () => {
    live = false
  }
}

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
