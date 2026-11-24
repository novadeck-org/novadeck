import { writeChatOfferAnswered } from "@novadeck/core/agents/chat-offer"
import type { PortableState } from "@novadeck/core/desktop/portable"
import {
  readPortableCardRaised,
  writePortableCardRaised,
} from "@novadeck/core/desktop/portable-card-raised"
import { aloneInWindows, type ProjectWindowsState } from "@novadeck/core/desktop/project-windows"
import type { SandboxState } from "@novadeck/core/desktop/sandbox"
import type { UpdateOffer, WhatsNew } from "@novadeck/core/desktop/update"
import type { AgentName } from "@novadeck/core/harnesses"
import type { Backend } from "@novadeck/core/port"
import { hasTile, orderedTiles } from "@novadeck/core/roster"
import { activeProject } from "@novadeck/core/state"
import { createStore, type MutableStore, type Store } from "@novadeck/core/store"
import type { PreferencesValue, Workspace } from "@novadeck/core/types"

import { writePreferences } from "../preferences/preferences-storage"
import { noArrangement, type ProjectArrangement } from "../projects/project-arrangement"
import {
  forgetStoredProjectArrangement,
  readStoredProjectArrangement,
} from "../projects/project-arrangement-storage"
import { initialShell, resetPresentation, type ShellState } from "../shell/shell-state"
import { writeSidebarCollapsed, writeWindowedView } from "../shell/shell-storage"
import type { MoveAsk, MoveNotice, MovePick } from "../terminals/move-state"
import { nextRecent, visibleSwitcher, withoutGone, type RecentSwitcher } from "../terminals/recent"
import type { RenameSession } from "../terminals/rename-state"
import { noFoldedTeams, writeFoldedTeams, type FoldedTeams } from "../terminals/team-fold"
import { noUnread, type Unread, type Viewing } from "../terminals/unread-state"
import { noFeatureFlags, type FeatureFlag, type FeatureFlags } from "./feature-flags"
import type { WorkspaceRoute } from "./routing"
import { currentContext, currentState } from "./selectors"

// Presentation state the workspace model does not own. One store per App; it
// starts over on reload apart from the slices persisted below.
// What Novadeck tells the person of something done elsewhere: `said` what happened, and
// `subject` where that leaves them.
export type ToldNotice = {
  readonly id: string
  readonly said: string
  readonly subject: string
}

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
  // The file each session's project window shows as a preview of what the agents' work merges to
  // (the Files tree and the Worktrees panel open files so), by session context; a session
  // without one shows the file as it is in main. Never persisted.
  readonly filePreviews: Readonly<Record<string, FilePreviewRequest>>
  // The agents the Files panel lights while it shows, by handle: the kept ones, else the
  // selected terminal's: what the file preview emphasizes. Never persisted.
  readonly filesLit: ReadonlySet<string>
  // A close waiting for the person to confirm it, since a program runs in the terminal.
  readonly closing: { readonly context: string; readonly id: string } | null
  // A terminal on its way to another session while the person picks where (`move-state.ts`).
  readonly moving: MovePick | null
  // A teammate's move waiting for the person to say whether it goes alone or with its team.
  readonly moveAsk: MoveAsk | null
  // The last move, for its toast; never persisted.
  readonly moved: MoveNotice | null
  // What Novadeck last told the person of something done elsewhere, as the session or project
  // they were on being removed in another window, for its toast; never persisted.
  readonly told: ToldNotice | null
  // The agent whose switch Preferences should bring into view when it opens, until it has.
  readonly agentFocus: AgentName | null
  // The person chose "Not now" for this crash loop; it asks again only after the next one.
  readonly crashLoopDismissed: boolean
  // Whether Preferences shows the Experimental switch while it is off: the person tapped the
  // version ten times, or had the switch on, in this run. Never persisted, so a switch turned off
  // hides again at the next launch.
  readonly experimentalRevealed: boolean
  // Which addon's offer (voice input or murmur) came up in this run of the app: each run
  // offers at most one unasked ("none": a window that is not the app's first leaves it to
  // the first); never persisted.
  readonly addonOffer: "voice" | "murmur" | "none" | null
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
  // while it has none to show or has not answered yet.
  readonly whatsNew: WhatsNew | null
  // Whether Agent Chat's one-time offer (the footer's card) has been answered, by either
  // button, or by the person choosing the chat view's setting themselves. Kept beside the
  // preferences (`chat-offer.ts` of core), as it is a note of what was asked, not a setting.
  readonly chatOfferAnswered: boolean
  // Whether the offer waits out this run: the welcome dialog finished with Agent Chat unticked on
  // purpose, which is no answer, so it is offered at a later launch. Never persisted; a reload
  // counts as a new run.
  readonly chatOfferHeld: boolean
  // Whether the desktop app runs in its security sandbox, as it said at startup; null until
  // then, and where it does not say.
  readonly sandbox: SandboxState | null
  // Whether its notice is open. It and the update's share a place, so one open closes the other.
  readonly sandboxOpen: boolean
  // Whether the desktop app is a portable copy, as it said at startup; null until it has, and
  // where it says nothing.
  readonly portable: PortableState | null
  // Whether the page has the person's focus: its window focused and showing.
  readonly pageFocused: boolean
  // What the desktop app says of its other windows: the projects they show, and whether this
  // is the window the person used last, the only one that rings (`watchProjectWindows`);
  // never persisted.
  readonly windows: ProjectWindowsState
  // Whether another window has shown a project since this page loaded, or this window is not the
  // app's first: from then on a project is read from the runner as it is shown, as another window
  // may have made or removed its sessions. A window that was always alone has the live copy
  // (`watchProjectWindows`); never persisted.
  readonly windowsShared: boolean
  // How many new Inbox entries that need the person the bell has rung for in this run
  // (`watchBellRings`): its dot rings with each; never persisted.
  readonly bellRings: number
  // How many times a terminal of the open project landed in History in this run
  // (`watchHistoryDrops`): the History toggle's dot flares with each; never persisted.
  readonly historyDrops: number
  // The terminal that landed last, which the History toggle's tooltip and a live region name.
  readonly lastDrop: HistoryDrop | null
  // The terminals with finished turns the person hasn't read: the Inbox's stored rows,
  // mirrored by `watchUnreadTurns`; never persisted.
  readonly unread: Unread
  // How the person arranged the switcher's projects: their order and the pinned ones.
  readonly projectArrangement: ProjectArrangement
  // The teams the person folded into their leads in the Terminals list (team-fold.ts).
  readonly foldedTeams: FoldedTeams
  // The lead whose team folds or unfolds if the person clicks where they point now, beside its
  // tab: its teammates' tabs show what a click does; never persisted.
  readonly foldPreview: { readonly context: string; readonly lead: string } | null
  // The lead whose team the person last unfolded: its teammates' tabs unroll from it as they
  // come back, where a tab merely mounting, as on a session switch, appears at once; never
  // persisted.
  readonly unfolding: { readonly context: string; readonly lead: string } | null
  // The lead whose team the person just folded: the rows its tab grows for its teammates grow
  // in, where rows merely mounting, as on a session switch, appear at once; never persisted.
  readonly folding: { readonly context: string; readonly lead: string } | null
  // Which of the app's unfinished parts the person turned on; never persisted, as the desktop app
  // remembers them.
  readonly flags: FeatureFlags
}

// A file the project window was opened on to preview: the window's item, the project and the
// file's path from the project's folder. `opened` is new each time it is opened, which has the
// preview start over (everyone merged).
export type FilePreviewRequest = {
  readonly itemId: string
  readonly projectId: string
  readonly path: string
  // The window points at an agent's copy of the file in its worktree, as main lacks it.
  readonly backed: boolean
  readonly opened: string
}

export type HistoryDrop = {
  readonly title: string
  // The handle of the agent that closed it; null when the person did.
  readonly closedBy: string | null
}

export type UiLocation = {
  readonly route: WorkspaceRoute
  // History entries the open dialog added above its background entry.
  readonly dialogDepth: number
  readonly navigationType: "POP" | "PUSH" | "REPLACE"
}

export type UiStore = MutableStore<UiState>

const noLit: ReadonlySet<string> = new Set()

export const createUiStore = (initial: UiState): UiStore => createStore(initial)

// A fresh App's UI: only the slices persisted below come from storage.
export const initialUi = ({
  location,
  preferences,
  sidebarCollapsed = false,
  chatOfferAnswered = false,
  projectArrangement = noArrangement,
  foldedTeams = noFoldedTeams,
  extraWindow = false,
}: {
  location: UiLocation
  preferences: PreferencesValue
  sidebarCollapsed?: boolean
  chatOfferAnswered?: boolean
  projectArrangement?: ProjectArrangement
  foldedTeams?: FoldedTeams
  // A window that is not the app's first: the one-time offers are left to the first.
  extraWindow?: boolean
}): UiState => ({
  location,
  preferences,
  shell: initialShell(sidebarCollapsed),
  rename: null,
  recent: { switcher: null, byContext: {} },
  created: null,
  filePreviews: {},
  filesLit: noLit,
  closing: null,
  moving: null,
  moveAsk: null,
  moved: null,
  told: null,
  agentFocus: null,
  crashLoopDismissed: false,
  experimentalRevealed: false,
  addonOffer: extraWindow ? "none" : null,
  nameOffer: null,
  crashLoop: 0,
  update: null,
  portableCardOpen: false,
  whatsNew: null,
  chatOfferAnswered,
  chatOfferHeld: extraWindow,
  sandbox: null,
  sandboxOpen: false,
  portable: null,
  pageFocused: true,
  windows: aloneInWindows,
  windowsShared: extraWindow,
  bellRings: 0,
  historyDrops: 0,
  lastDrop: null,
  unread: noUnread,
  projectArrangement,
  foldedTeams,
  foldPreview: null,
  unfolding: null,
  folding: null,
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
    persist(ui, (state) => state.chatOfferAnswered, writeChatOfferAnswered),
    persist(ui, (state) => state.foldedTeams, writeFoldedTeams),
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

const importing = new WeakSet<UiStore>()

// Has the backend keep the arrangement as the person changes it. A change made before the
// backend answers is sent as it is, in order; opening a client sends nothing. An arrangement
// an earlier client left in storage is sent once first (the store was seeded from it) and
// forgotten once the backend has it or any arrangement since; a failed send leaves it for
// the next load. How another client arranged the projects (`arranged`) is taken as it comes,
// and never sent back, unless the person's own is still on its way, which comes back after.
export const keepProjectArrangement = (
  ui: UiStore,
  arrange: NonNullable<Backend["arrange"]>,
  arranged?: Backend["arranged"],
): (() => void) => {
  let sending = 0
  const send = (arrangement: ProjectArrangement): void => {
    sending += 1
    arrange(arrangement)
      .then(forgetStoredProjectArrangement, () => {})
      .finally(() => (sending -= 1))
  }
  const stored = importing.has(ui) ? undefined : readStoredProjectArrangement()
  if (stored) {
    importing.add(ui)
    send(stored)
  }
  let sent = ui.getSnapshot().projectArrangement
  const stop = ui.subscribe(() => {
    const next = ui.getSnapshot().projectArrangement
    if (next === sent) return
    sent = next
    send(next)
  })
  const stopArranged = arranged?.((there) => {
    if (sending > 0 || readStoredProjectArrangement() !== undefined) return
    const here = ui.getSnapshot().projectArrangement
    if (sameArrangement(here, there)) return
    const taken: ProjectArrangement = { order: [...there.order], pinned: [...there.pinned] }
    sent = taken
    ui.update((state) => ({ ...state, projectArrangement: taken }))
  })
  return () => {
    stop()
    stopArranged?.()
  }
}

const sameArrangement = (
  a: { readonly order: readonly string[]; readonly pinned: readonly string[] },
  b: { readonly order: readonly string[]; readonly pinned: readonly string[] },
): boolean =>
  a.order.join("\n") === b.order.join("\n") && a.pinned.join("\n") === b.pinned.join("\n")

// Closes the switcher once a dialog opens or the session changes under it, and lets go of
// the rows of terminals that close while it shows, so none it offers is gone.
export const watchSwitcher = (workspace: Store<Workspace>, ui: UiStore): (() => void) => {
  const check = (): void => {
    const { recent, location } = ui.getSnapshot()
    if (!recent.switcher) return
    const snapshot = workspace.getSnapshot()
    const context = currentContext(snapshot)
    const { roster } = currentState(snapshot)
    const switcher = visibleSwitcher(recent.switcher, context, location.route.dialog)
      ? withoutGone(recent.switcher, (id) => hasTile(roster, id))
      : null
    if (switcher === recent.switcher) return
    ui.update((state) => ({
      ...state,
      recent: { ...state.recent, switcher },
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
// a bar. An offer heard before the desktop app says whether this is a portable copy is raised once
// it does (`watchPortable`).
// Once per launch is what the desktop app's run name says, kept beyond the page's life
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

// Whether terminals show their agents' chat: the person turned the chat view on.
export const chatViewOn = (state: Pick<UiState, "preferences">): boolean =>
  state.preferences.chatView

// Notes that Agent Chat's offer was answered: it is never made again, in this window or a later
// launch (`persistUi` keeps the note).
export const answerChatOffer = (ui: UiStore): void =>
  void ui.update((state) =>
    state.chatOfferAnswered ? state : { ...state, chatOfferAnswered: true },
  )

// Holds Agent Chat's offer back for the rest of this run, without answering it.
export const holdChatOffer = (ui: UiStore): void =>
  void ui.update((state) => (state.chatOfferHeld ? state : { ...state, chatOfferHeld: true }))

// Shows Preferences' Experimental switch for the rest of this run, whatever it is set to.
export const revealExperimental = (ui: UiStore): void =>
  void ui.update((state) =>
    state.experimentalRevealed ? state : { ...state, experimentalRevealed: true },
  )

// Whether tabs and window headers show terminals' critters: the person turned Agent avatars
// on, one of the experimental features, so they show only while IS_EXPERIMENTAL is on.
export const agentAvatarsOn = (state: Pick<UiState, "preferences" | "flags">): boolean =>
  state.flags.IS_EXPERIMENTAL && state.preferences.agentAvatars

/** Whether the footer offers the onboarding tour: its own switch, with Experimental on. */
export const onboardingTourOn = (state: Pick<UiState, "preferences" | "flags">): boolean =>
  state.flags.IS_EXPERIMENTAL && state.preferences.onboardingTour

// Turns one feature flag on or off, as is: `setFeatureFlag` of the workspace's commands also
// starts terminals afresh on the chat view where the flag turns it on or off.
export const setFeatureFlag = (ui: UiStore, flag: FeatureFlag, on: boolean): void => {
  ui.update((state) =>
    state.flags[flag] === on ? state : { ...state, flags: { ...state.flags, [flag]: on } },
  )
}

// Turns agent worktrees off where they are on, as the Experimental switch going off does, so the
// setting never stays on without its toggle.
export const switchOffWorktrees = (worktrees: Backend["worktrees"]): void => {
  if (worktrees?.enabled.getSnapshot()) worktrees.set(false)
}

// Turns the agent modes switch off where it is on, as the Experimental switch going off does:
// the runner then has agents work as a Herd, and the saved pick stays for when it goes on again.
export const switchOffAgentModes = (agentModes: Backend["agentModes"]): void => {
  if (agentModes?.enabled.getSnapshot()) agentModes.set(false)
}

// Turns the shipping gate off where it is on, as the Experimental switch going off does: the
// runner then stops gating and leaves what the harnesses do as it was.
export const switchOffShippingGate = (shippingGate: Backend["shippingGate"]): void => {
  if (shippingGate?.enabled.getSnapshot()) shippingGate.set(false)
}

// Switches every forge integration off where it is on, as the Experimental switch going off does,
// for the same reason.
// A forge being switched (on, as far as anyone knows) goes off too: its switch lands after.
export const switchOffForges = (forges: Backend["forges"]): void => {
  for (const connection of forges?.state.getSnapshot() ?? [])
    if (connection.enabled || connection.busy) forges?.set(connection.forge, false)
}

// The Experimental features a backend keeps as settings, which all go off with the switch.
export type ExperimentalFeatures = Pick<
  Backend,
  "worktrees" | "forges" | "agentModes" | "shippingGate"
>

export const switchOffExperimental = ({
  worktrees,
  forges,
  agentModes,
  shippingGate,
}: ExperimentalFeatures): void => {
  switchOffWorktrees(worktrees)
  switchOffAgentModes(agentModes)
  switchOffShippingGate(shippingGate)
  switchOffForges(forges)
}

// Asks the backend once, as the workspace comes up, whether the desktop app follows experimental
// builds, which is what turns IS_EXPERIMENTAL on, through `set`. A desktop app that fails to say
// leaves it off. A channel found stable, or unreadable, also turns agent worktrees, agent modes and
// forge integrations off.
export const watchExperimental = (
  updates: Backend["updates"],
  set: (on: boolean) => void,
  features: ExperimentalFeatures = {},
): (() => void) => {
  let live = true
  void updates?.channel?.get().then(
    (channel) => {
      if (!live) return
      set(channel === "experimental")
      if (channel !== "experimental") switchOffExperimental(features)
    },
    // A desktop app that fails to say counts as not experimental for these features.
    () => {
      if (live) switchOffExperimental(features)
    },
  )
  return () => {
    live = false
  }
}

// Asks the backend once, as the workspace comes up, what is new in the version the app
// updated to, and keeps the answer for the footer's card. Whether the card is due at all
// (a version updated to, its notes read, not dismissed) is the desktop app's to say: the page
// keeps no memory of its own. A desktop app that fails to answer has nothing to show, and it is
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

// The person dismissed the card: the desktop app remembers, so no later launch offers it again,
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
// footer. A portable copy raises its card now, offer or not. A desktop app that fails to say is
// taken as not saying. A state the desktop app pushes later (each step of an install) replaces
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
    // A desktop app that fails to say is not one, so nothing waits on its answer.
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
// answer for the footer. A desktop app that fails to say is taken as not saying.
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

// A pick of where a terminal goes, and a teammate's move waiting on the person, belong to the
// session they were asked in, as a close's confirmation does: leaving it, or the terminal
// going, drops them. A pick also belongs to the Sessions panel, so leaving that panel ends it,
// and a later visit opens sessions as usual.
export const watchMoving = (workspace: Store<Workspace>, ui: UiStore): (() => void) => {
  const stops = [
    workspace.subscribe(() => dropStaleMove(workspace, ui)),
    ui.subscribe(() => {
      const { moving, location } = ui.getSnapshot()
      if (moving && location.route.panel !== "sessions")
        ui.update((state) => ({ ...state, moving: null }))
    }),
  ]
  return () => stops.forEach((stop) => stop())
}

const dropStaleMove = (workspace: Store<Workspace>, ui: UiStore): void => {
  const { moving, moveAsk } = ui.getSnapshot()
  if (!moving && !moveAsk) return
  const snapshot = workspace.getSnapshot()
  const context = currentContext(snapshot)
  const held = (id: string) =>
    currentState(snapshot).roster.terminals.some((terminal) => terminal.id === id)
  const keep = (each: { context: string; terminalId: string } | null) =>
    each !== null && each.context === context && held(each.terminalId)
  if (keep(moving) === (moving !== null) && keep(moveAsk) === (moveAsk !== null)) return
  ui.update((state) => ({
    ...state,
    moving: keep(state.moving) ? state.moving : null,
    moveAsk: keep(state.moveAsk) ? state.moveAsk : null,
  }))
}

// The terminal the person looks at: the selected one of the session on screen, while the
// page has their focus.
export const viewing = (workspace: Workspace, ui: Pick<UiState, "pageFocused">): Viewing => {
  const { selected } = currentState(workspace)
  return ui.pageFocused && selected ? { context: currentContext(workspace), id: selected } : null
}
