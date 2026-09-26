import { History, Plus, Terminal as TerminalIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { HashRouter, useNavigationType } from "react-router"

import { ToggleGroup, ToggleGroupItem } from "../ui-toolkit/ToggleGroup"
import { backgroundPointerHandlers } from "../workspace/layouts/background"
import { Canvas, type CanvasHandle } from "../workspace/layouts/Canvas"
import { Focus } from "../workspace/layouts/Focus"
import { Grid } from "../workspace/layouts/Grid"
import {
  cancelTerminalTransition,
  transitionTerminal,
  transitionWorkspace,
} from "../workspace/layouts/transition"
import {
  mockReply,
  initialProjects,
  projectSessions,
  createMockTerminal,
} from "../workspace/mock/sessions"
import {
  activeProject,
  activeSession,
  createWorkspace,
  createWorkspaceSession,
  createSessionState,
  orderedSessions,
  workspaceReducer,
  type ValueUpdate,
} from "../workspace/model/state"
import type {
  Project,
  Session,
  Entry,
  ViewMode,
  WindowedView,
  PreferencesValue,
  CanvasLayout,
  GridLayouts,
  WorkspaceSession,
  WorkspaceTarget,
} from "../workspace/model/types"
import { Preferences } from "../workspace/preferences/Preferences"
import {
  viewModes,
  preferencesStorageKey,
  readPreferences,
} from "../workspace/preferences/preferences-storage"
import { TerminalSearch } from "../workspace/search/TerminalSearch"
import { WorkspaceHeader } from "../workspace/shell/WorkspaceHeader"
import { useDesktop, WorkspacePanels } from "../workspace/shell/WorkspacePanels"
import { ZenDock } from "../workspace/shell/ZenDock"
import {
  matchesShortcut,
  shortcutBindings,
  workspaceOverlayOpen,
  workspaceShortcutBindings,
  workspaceShortcutTarget,
} from "../workspace/shortcuts"
import { SessionsPanel } from "../workspace/sidebar/SessionsPanel"
import { SidebarPanel, sidebarCreateClasses } from "../workspace/sidebar/SidebarPanel"
import { SessionList } from "../workspace/terminals/SessionList"
import { Terminal, type MinimizeControls } from "../workspace/terminals/Terminal"
import type { TerminalRename } from "../workspace/terminals/TerminalRenameInput"
import { TerminalSwitcher } from "../workspace/terminals/TerminalSwitcher"
import { routeUrl } from "./routing"
import { useRouteDialog } from "./useRouteDialog"
import { useWorkspaceRoute } from "./useWorkspaceRoute"

const collapsedStorageKey = "novadeck.sidebar-collapsed"
const readSidebarCollapsed = (): boolean => {
  try {
    return localStorage.getItem(collapsedStorageKey) === "true"
  } catch {
    return false
  }
}
const windowedStorageKey = "novadeck.windowed-view"
const readWindowedView = (): WindowedView => {
  try {
    return localStorage.getItem(windowedStorageKey) === "canvas" ? "canvas" : "grid"
  } catch {
    return "grid"
  }
}
const emptyEntries: Entry[] = []
type RenameSession = {
  context: string
  id: string
  original: string
  draft: string
  origin: "sidebar" | "header"
  view: ViewMode
  target: WorkspaceTarget
  request: number
}
type AddTerminalOptions = { fromKeyboard?: boolean; beginRename?: boolean }
const currentTimestamp = (): number => Date.now()
const newWorkspaceSession = (
  terminals: Session[],
  view: ViewMode,
  windowedView: WindowedView,
): WorkspaceSession => {
  const now = Date.now()
  return createWorkspaceSession(
    {
      name: new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(now),
      state: createSessionState(terminals, view, windowedView),
    },
    { id: crypto.randomUUID(), now },
  )
}

const initializeWorkspace = (preferences: PreferencesValue) => {
  const view = preferences.enabledViews.includes("focus") ? "focus" : preferences.enabledViews[0]!
  return initialProjects.reduce(
    (workspace, project) => {
      const session = newWorkspaceSession(projectSessions(project), view, readWindowedView())
      return workspaceReducer(workspace, {
        type: "session/add",
        projectId: project.id,
        session: { ...session, id: "initial" },
      })
    },
    createWorkspace({ projects: initialProjects, activeProjectId: initialProjects[0]!.id }),
  )
}

const useWorkspaceTarget = (projectId: string, workspaceSessionId: string) =>
  useMemo(() => ({ projectId, workspaceSessionId }), [projectId, workspaceSessionId])

const useLayoutHidden = (hidden: Record<string, boolean>, preview: string) =>
  useMemo(() => (preview ? { ...hidden, [preview]: false } : hidden), [hidden, preview])

export const App = (): React.JSX.Element => (
  <HashRouter useTransitions={false}>
    <WorkspaceApp />
  </HashRouter>
)

export const WorkspaceApp = (): React.JSX.Element => {
  const desktop = useDesktop()
  const navigationType = useNavigationType()
  const [preferences, setPreferences] = useState(readPreferences)
  const { workspace, dispatch, route, go, navigateWorkspace, closeDialog } = useWorkspaceRoute(
    preferences,
    initializeWorkspace,
  )
  const project = activeProject(workspace)!
  const current = activeSession(workspace)!
  const projectId = project.id
  const workspaceSessionId = current.id
  const projects = workspace.projects
  const workspaceSessions = project.history
  const {
    view,
    windowedView,
    sessions,
    selected,
    entries,
    cleared,
    drafts,
    scrollOffsets,
    canvasLayout,
    gridLayouts,
    gridRestoreWidths,
    gridMinimized,
    sizePresets,
    hidden,
    nextTerminalNumber,
  } = current.state
  const ordered = orderedSessions(current.state)
  const preview = hidden[selected] ? selected : ""
  const layoutHidden = useLayoutHidden(hidden, preview)
  const target = useWorkspaceTarget(projectId, workspaceSessionId)
  const setSelected = (terminal: string): void => go({ terminal })
  const setVisibility = (terminalId: string, isHidden: boolean): void =>
    dispatch({ type: "terminal/visibility", target, terminalId, hidden: isHidden })
  const setCanvasLayout = useCallback(
    (layout: ValueUpdate<CanvasLayout>) => dispatch({ type: "canvas/layout", target, layout }),
    [dispatch, target],
  )
  const setGridLayouts = useCallback(
    (layouts: ValueUpdate<GridLayouts>) => dispatch({ type: "grid/layouts", target, layouts }),
    [dispatch, target],
  )
  const setTabOrder = (tabOrder: string[]): void =>
    dispatch({ type: "terminal/reorder", target, tabOrder })
  const sidebarPanel = route.panel
  const setSidebarPanel = (panel: "terminals" | "sessions"): void => go({ panel })
  const [created, setCreated] = useState<{ context: string; id: string } | null>(null)
  const [renameSession, setRenameSession] = useState<RenameSession | null>(null)
  const renameRequest = useRef(0)
  const [revealCanvas, setRevealCanvas] = useState(false)
  const [keyboardFocus, setKeyboardFocus] = useState<{ id: string; view: ViewMode } | null>(null)
  const [canvasKeyboardFocus, setCanvasKeyboardFocus] = useState<{
    context: string
    id: string
    request: number
  } | null>(null)
  const canvasFocusRequest = useRef(0)
  const canvas = useRef<CanvasHandle>(null)
  const [recentSwitcher, setRecentSwitcher] = useState<{
    context: string
    ids: string[]
    index: number
    fromInput: boolean
    mode: "held" | "click"
  } | null>(null)
  const switcherTrigger = useRef<HTMLButtonElement | null>(null)
  const recentByContext = useRef<Record<string, string[]>>({})
  const [navigation, setNavigation] = useState({ count: 1, fit: false })
  const { searching, settings, onExitComplete } = useRouteDialog(
    route.dialog,
    `${projectId}/${workspaceSessionId}`,
  )
  const [zen, setZen] = useState<{
    sidebar: boolean
    collapsed: boolean
    panel: "sessions" | "terminals"
  } | null>(null)
  const [sidebar, setSidebar] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed)
  const sidebarVisible = !zen && (desktop ? !sidebarCollapsed : sidebar)
  const context = `${projectId}/${workspaceSessionId}`
  const activeRename = renameSession?.context === context ? renameSession : null
  const renameView: TerminalRename | null = activeRename
    ? {
        id: activeRename.id,
        value: activeRename.draft,
        request: activeRename.request,
        origin: activeRename.origin,
      }
    : null
  const finishRename = useCallback(
    (rename: RenameSession, save: boolean): void => {
      const name = rename.draft.trim()
      if (save && name && name !== rename.original)
        dispatch({ type: "terminal/rename", target: rename.target, terminalId: rename.id, name })
      setRenameSession((previous) => (previous?.request === rename.request ? null : previous))
    },
    [dispatch, setRenameSession],
  )
  const startRename = (session: Session, origin: RenameSession["origin"]): void => {
    if (activeRename?.id === session.id) return
    if (activeRename) finishRename(activeRename, true)
    setRenameSession({
      context,
      id: session.id,
      original: session.name,
      draft: session.name,
      origin,
      view,
      target,
      request: ++renameRequest.current,
    })
  }
  const changeRenameDraft = (id: string, draft: string): void =>
    setRenameSession((previous) =>
      previous?.context === context && previous.id === id ? { ...previous, draft } : previous,
    )
  const saveRename = (id: string): void => {
    if (activeRename?.id === id) finishRename(activeRename, true)
  }
  const cancelRename = (id: string): void => {
    if (activeRename?.id === id) finishRename(activeRename, false)
  }
  const [focusPreview, setFocusPreview] = useState<{ context: string; id: string } | null>(null)
  const displayed = selected || (focusPreview?.context === context ? focusPreview.id : "")
  const active = sessions.find((session) => session.id === displayed) ?? sessions[0]
  const windowedDestination = preferences.enabledViews.includes(windowedView)
    ? windowedView
    : preferences.enabledViews.find((mode) => mode !== "focus")
  const windowedLabel = windowedDestination === "canvas" ? "Canvas" : "Grid"
  const searchLabel = view === "canvas" ? "Canvas" : view === "grid" ? "Grid" : "Focus"
  useEffect(() => {
    try {
      localStorage.setItem(windowedStorageKey, windowedView)
    } catch {
      /* Remains available for this session when storage is unavailable. */
    }
  }, [windowedView])
  useEffect(() => {
    try {
      localStorage.setItem(preferencesStorageKey, JSON.stringify(preferences))
    } catch {
      /* Preferences still apply when storage is unavailable. */
    }
  }, [preferences])
  useEffect(() => {
    try {
      localStorage.setItem(collapsedStorageKey, String(sidebarCollapsed))
    } catch {
      /* Collapsing still works when storage is unavailable. */
    }
  }, [sidebarCollapsed])

  const presentation = `${projectId}/${workspaceSessionId}/${view}/${selected}`
  const visibleRecentSwitcher =
    recentSwitcher?.context === context && !route.dialog ? recentSwitcher : null
  if (recentSwitcher && !visibleRecentSwitcher) setRecentSwitcher(null)
  const closeRecentSwitcher = (): void => {
    const trigger = visibleRecentSwitcher?.mode === "click" ? switcherTrigger.current : null
    setRecentSwitcher(null)
    queueMicrotask(() => trigger?.isConnected && trigger.focus({ preventScroll: true }))
  }
  const openRecentSwitcher = (id: string, trigger: HTMLButtonElement): void => {
    const ids = recentByContext.current[context] ?? ordered.map((session) => session.id)
    switcherTrigger.current = trigger
    setRecentSwitcher({
      context,
      ids,
      index: Math.max(0, ids.indexOf(id)),
      fromInput: false,
      mode: "click",
    })
  }
  useEffect(() => {
    const previous = recentByContext.current[context] ?? []
    recentByContext.current[context] = [
      ...(selected ? [selected] : []),
      ...previous.filter((id) => id !== selected && sessions.some((session) => session.id === id)),
      ...ordered
        .map((session) => session.id)
        .filter((id) => id !== selected && !previous.includes(id)),
    ]
  })
  useEffect(() => {
    if (!created) return
    const timeout = window.setTimeout(() => setCreated(null), 900)
    return () => window.clearTimeout(timeout)
  }, [created])
  useEffect(() => {
    if (!canvasKeyboardFocus) return
    if (
      canvasKeyboardFocus.context === context &&
      view === "canvas" &&
      canvasKeyboardFocus.id === selected
    )
      return
    const request = canvasKeyboardFocus.request
    queueMicrotask(() =>
      setCanvasKeyboardFocus((previous) => (previous?.request === request ? null : previous)),
    )
  }, [canvasKeyboardFocus, context, selected, view])
  useEffect(() => {
    if (!renameSession) return
    if (
      renameSession.context === context &&
      renameSession.view === view &&
      sessions.some((session) => session.id === renameSession.id)
    )
      return
    let canceled = false
    queueMicrotask(() => {
      if (!canceled) finishRename(renameSession, true)
    })
    return () => {
      canceled = true
    }
  }, [context, finishRename, renameSession, sessions, view])
  const lastSelectedForRename = useRef(selected)
  useEffect(() => {
    const changed = lastSelectedForRename.current !== selected
    lastSelectedForRename.current = selected
    if (!changed || !activeRename || activeRename.id === selected) return
    let canceled = false
    queueMicrotask(() => {
      if (!canceled) finishRename(activeRename, true)
    })
    return () => {
      canceled = true
    }
  }, [activeRename, finishRename, selected])
  const [freshSession, setFreshSession] = useState<string | null>(null)
  const [previousPresentation, setPreviousPresentation] = useState({ presentation, context })
  if (previousPresentation.presentation !== presentation) {
    setPreviousPresentation({ presentation, context })
    if (previousPresentation.context !== context || navigationType === "POP") {
      setNavigation((value) => ({ count: value.count + 1, fit: false }))
      setRevealCanvas(false)
      setSidebar(freshSession === workspaceSessionId)
      setFreshSession(null)
    }
  }
  useEffect(() => {
    if (navigationType === "POP" && presentation) cancelTerminalTransition()
  }, [navigationType, presentation])
  const switchSession = (id: string): void => {
    if (id === workspaceSessionId) return
    const next = workspaceSessions.find((item) => item.id === id)
    if (!next) return
    const now = currentTimestamp()
    navigateWorkspace([
      {
        type: "session/select",
        projectId,
        workspaceSessionId: id,
        now,
        enabledViews: preferences.enabledViews,
      },
    ])
  }
  const startFresh = (): void => {
    const next = newWorkspaceSession([], view, windowedView)
    const name = next.name
    let suffix = 2
    while (workspaceSessions.some((item) => item.name === next.name))
      next.name = `${name} (${suffix++})`
    setFreshSession(next.id)
    setSidebarCollapsed(false)
    navigateWorkspace([{ type: "session/add", projectId, session: next }], { panel: "sessions" })
  }
  const showSessions = (): void => {
    setZen(null)
    setSidebarPanel("sessions")
    setSidebarCollapsed(false)
    setSidebar(true)
  }
  const hideSidebar = (): void => {
    setSidebarCollapsed(true)
    setSidebar(false)
    if (desktop) document.getElementById(`${sidebarPanel}-toggle`)?.focus()
  }
  const toggleSidebar = (panel: "terminals" | "sessions"): void => {
    if (zen) setZen(null)
    if (sidebarPanel === panel && sidebarVisible) hideSidebar()
    else {
      setSidebarPanel(panel)
      setSidebarCollapsed(false)
      setSidebar(true)
    }
  }
  const enterZen = (): void => {
    if (zen) return
    setZen({ sidebar, collapsed: sidebarCollapsed, panel: sidebarPanel })
    requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>(".zen-create")?.focus({ preventScroll: true }),
    )
  }
  const exitZen = (): void => {
    if (!zen) return
    setSidebar(zen.sidebar)
    setSidebarCollapsed(zen.collapsed)
    setSidebarPanel(zen.panel)
    setZen(null)
    requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>(".zen-enter")?.focus({ preventScroll: true }),
    )
  }
  const switchProject = (next: Project): void => {
    if (next.id === projectId) return
    const now = currentTimestamp()
    navigateWorkspace([
      {
        type: "project/select",
        projectId: next.id,
        now,
        enabledViews: preferences.enabledViews,
      },
    ])
  }
  const select = (id: string, fit = false): void => {
    setSelected(id)
    setNavigation((value) => ({ count: value.count + 1, fit }))
    setSidebar(false)
  }
  const updatePreferences = (next: PreferencesValue): void => {
    cancelTerminalTransition()
    setPreferences(next)
    dispatch({ type: "preferences/reconcile", target, preferences: next })
    if (!next.enabledViews.includes(view)) {
      setRevealCanvas(false)
      setSidebar(false)
    }
  }
  const changeView = (next: ViewMode): void => {
    if (!preferences.enabledViews.includes(next)) return
    navigateWorkspace([
      { type: "view/change", target, view: next, enabledViews: preferences.enabledViews },
    ])
    setRevealCanvas(false)
    setSidebar(false)
  }
  const showWindowed = (id: string): void => {
    if (!windowedDestination) return
    setNavigation((value) => ({ count: value.count + 1, fit: false }))
    setSidebar(false)
    setRevealCanvas(windowedDestination === "canvas")
    navigateWorkspace(
      [
        {
          type: "view/change",
          target,
          view: windowedDestination,
          enabledViews: preferences.enabledViews,
          rememberWindowed: false,
        },
      ],
      { terminal: id },
    )
  }
  const openWindowed = (id: string): void => transitionTerminal(id, () => showWindowed(id))
  const openSearchResult = (id: string): void => {
    go({ terminal: id, dialog: null })
    setNavigation((value) => ({ count: value.count + 1, fit: view === "canvas" }))
    setSidebar(false)
  }
  const add = ({ fromKeyboard = false, beginRename = true }: AddTerminalOptions = {}): string => {
    setRecentSwitcher(null)
    const session = createMockTerminal(nextTerminalNumber, project.directory)
    if (activeRename) finishRename(activeRename, true)
    const origin = !zen && desktop && (fromKeyboard || !sidebarCollapsed) ? "sidebar" : "header"
    setCreated({ context, id: session.id })
    if (beginRename)
      setRenameSession({
        context,
        id: session.id,
        original: session.name,
        draft: session.name,
        origin,
        view,
        target,
        request: ++renameRequest.current,
      })
    const actions: Parameters<typeof navigateWorkspace>[0] = [
      { type: "terminal/add", target, session },
    ]
    navigateWorkspace(actions, { panel: "terminals" })
    setNavigation((value) => ({ count: value.count + 1, fit: false }))
    if (fromKeyboard) setSidebarCollapsed(false)
    setSidebar(false)
    return session.id
  }
  const close = (terminalId: string): void => {
    if (activeRename?.id === terminalId) finishRename(activeRename, false)
    navigateWorkspace([{ type: "terminal/close", target, terminalId }], {}, true)
    if (selected === terminalId && view !== "canvas")
      setNavigation((value) => ({ count: value.count + 1, fit: false }))
  }
  const run = (session: Session, command: string): void => {
    if (command.trim() === "clear") {
      dispatch({ type: "terminal/output-clear", target, terminalId: session.id })
      return
    }
    dispatch({
      type: "terminal/output-entry",
      target,
      terminalId: session.id,
      entry: { id: crypto.randomUUID(), command, reply: mockReply(command, session) },
    })
  }
  const terminal = (
    session: Session,
    compact: boolean,
    minimize?: MinimizeControls,
    onFlyTo?: () => void,
    onResizePreset?: (button: HTMLButtonElement) => void,
    large = false,
  ): React.JSX.Element => (
    <Terminal
      key={session.id}
      session={session}
      active={selected === session.id}
      fresh={created?.context === context && created.id === session.id}
      rename={renameView?.id === session.id ? renameView : null}
      onBeginRename={() => startRename(session, "header")}
      onRenameDraft={(draft) => changeRenameDraft(session.id, draft)}
      onRenameSave={() => saveRename(session.id)}
      onRenameCancel={() => cancelRename(session.id)}
      projectName={project.name}
      entries={entries[session.id] ?? emptyEntries}
      draft={drafts[session.id] ?? ""}
      onDraftChange={(draft) =>
        dispatch({ type: "terminal/draft", target, terminalId: session.id, draft })
      }
      scrollOffset={scrollOffsets[session.id]}
      onScrollChange={(offset) =>
        dispatch({ type: "terminal/scroll", target, terminalId: session.id, offset })
      }
      cleared={cleared[session.id] ?? false}
      onCommand={(command) => run(session, command)}
      focusInput={
        keyboardFocus?.id === session.id && keyboardFocus.view === view && selected === session.id
      }
      onInputFocused={() => setKeyboardFocus(null)}
      compact={compact}
      switcher={{ onOpen: (button) => openRecentSwitcher(session.id, button) }}
      onClose={() => close(session.id)}
      {...(minimize ? { minimize } : {})}
      {...(onFlyTo ? { onFlyTo } : {})}
      {...(onResizePreset
        ? {
            onResizePreset: (button: HTMLButtonElement) => {
              setSelected(session.id)
              onResizePreset(button)
            },
            resizeView: view === "grid" ? ("grid" as const) : ("canvas" as const),
          }
        : {})}
      large={large}
      {...(compact && preferences.enabledViews.includes("focus")
        ? {
            onFocus: () =>
              transitionTerminal(session.id, () => {
                go({ terminal: session.id, view: "focus" })
                setRevealCanvas(false)
                setSidebar(false)
              }),
          }
        : !compact && windowedDestination
          ? {
              windowed: {
                destination: windowedLabel,
                onOpen: () => openWindowed(session.id),
              },
            }
          : {})}
    />
  )

  useEffect(() => {
    const workspaceEscape = (event: KeyboardEvent): void => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        route.dialog ||
        visibleRecentSwitcher ||
        !workspaceShortcutTarget(event.target) ||
        (event.target instanceof Element &&
          Boolean(event.target.closest('.zen-dock[data-open="true"]')))
      )
        return
      if (
        workspaceOverlayOpen() ||
        document.querySelector(".session-tab.editing, .session-tab.dragging")
      )
        return
      if (!event.repeat && view === "canvas" && canvas.current?.returnToOrigin()) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (!selected && !sidebarVisible) return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      if (selected) {
        if (view === "focus") setFocusPreview({ context, id: selected })
        setKeyboardFocus(null)
        setSelected("")
        document
          .querySelector<HTMLElement>(view === "focus" ? ".focus-stage" : `.${view}-viewport`)
          ?.focus({ preventScroll: true })
      } else hideSidebar()
    }
    const workspaceArrows = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.altKey ||
        event.metaKey ||
        !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
      )
        return
      const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight"
      const direction = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1
      if (visibleRecentSwitcher) {
        if (horizontal) return
        event.preventDefault()
        event.stopPropagation()
        const { ids, index } = visibleRecentSwitcher
        setRecentSwitcher({
          ...visibleRecentSwitcher,
          index: (index + direction + ids.length) % ids.length,
        })
        return
      }
      if (route.dialog || event.ctrlKey || event.shiftKey) return
      const fromViewSwitch =
        event.target instanceof Element && Boolean(event.target.closest(".view-switch"))
      if (
        !fromViewSwitch &&
        (!workspaceShortcutTarget(event.target) ||
          (event.target instanceof Element &&
            Boolean(event.target.closest('[role="separator"], [role="radiogroup"]'))))
      )
        return
      event.preventDefault()
      event.stopPropagation()
      if (horizontal) {
        const modes = viewModes.filter((mode) => preferences.enabledViews.includes(mode))
        const next = modes[(modes.indexOf(view) + direction + modes.length) % modes.length]
        if (next && next !== view) changeView(next)
        return
      }
      if (!ordered.length) return
      const index = ordered.findIndex((session) => session.id === selected)
      const next =
        index < 0
          ? direction > 0
            ? 0
            : ordered.length - 1
          : (index + direction + ordered.length) % ordered.length
      const session = ordered[next]
      if (session) {
        const fromCanvasNode =
          view === "canvas" &&
          event.target instanceof Element &&
          Boolean(event.target.closest(".react-flow__node"))
        if (fromCanvasNode)
          setCanvasKeyboardFocus({
            context,
            id: session.id,
            request: ++canvasFocusRequest.current,
          })
        select(session.id)
        const fromTab =
          event.target instanceof Element && Boolean(event.target.closest(".session-tab"))
        if ((fromViewSwitch || fromTab) && sidebarVisible && sidebarPanel === "terminals")
          document
            .querySelector<HTMLElement>(`[data-session-id="${session.id}"] .sidebar-item-select`)
            ?.focus({ preventScroll: true })
      }
    }

    const keydown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      const shortcuts = shortcutBindings()
      const fromInput =
        event.target instanceof HTMLInputElement &&
        event.target.getAttribute("aria-label")?.startsWith("Command for ") === true
      const renamed =
        event.target instanceof Element &&
        Boolean(event.target.closest('input[aria-label^="Rename "]'))
      if (renamed) return
      if (visibleRecentSwitcher && event.key === "Escape") {
        event.preventDefault()
        closeRecentSwitcher()
        return
      }
      if (visibleRecentSwitcher?.mode === "click" && event.key === "Enter") {
        if (
          event.target instanceof Element &&
          event.target.closest('[aria-label="Close terminal switcher"]')
        )
          return
        event.preventDefault()
        const id = visibleRecentSwitcher.ids[visibleRecentSwitcher.index]
        setRecentSwitcher(null)
        if (id) {
          setKeyboardFocus({ id, view })
          select(id)
        }
        return
      }
      if (matchesShortcut(event, shortcuts.find)) {
        event.preventDefault()
        setRecentSwitcher(null)
        go({ dialog: "search" })
        return
      }
      if (matchesShortcut(event, shortcuts.preferences)) {
        event.preventDefault()
        setRecentSwitcher(null)
        go({ dialog: "preferences", section: "general" })
        return
      }
      if (route.dialog) return
      if (matchesShortcut(event, shortcuts.newSession)) {
        event.preventDefault()
        if (event.repeat) return
        setRecentSwitcher(null)
        startFresh()
        return
      }
      if (
        matchesShortcut(event, shortcuts.terminals) ||
        matchesShortcut(event, shortcuts.sessions)
      ) {
        event.preventDefault()
        if (event.repeat) return
        setRecentSwitcher(null)
        toggleSidebar(matchesShortcut(event, shortcuts.terminals) ? "terminals" : "sessions")
        return
      }
      if (matchesShortcut(event, shortcuts.recent) || matchesShortcut(event, shortcuts.previous)) {
        const ids = visibleRecentSwitcher?.ids ?? recentByContext.current[context] ?? []
        if (ids.length < 2) return
        event.preventDefault()
        const direction = matchesShortcut(event, shortcuts.previous) ? -1 : 1
        const index =
          ((visibleRecentSwitcher?.index ?? (selected ? 0 : -1)) + direction + ids.length) %
          ids.length
        setRecentSwitcher({
          context,
          ids,
          index,
          fromInput: visibleRecentSwitcher?.fromInput ?? fromInput,
          mode: visibleRecentSwitcher?.mode ?? "held",
        })
        return
      }
      if (matchesShortcut(event, shortcuts.focus)) {
        const next = view === "focus" ? windowedDestination : "focus"
        if (!next || !preferences.enabledViews.includes(next)) return
        event.preventDefault()
        if (event.repeat) return
        if (fromInput && selected) setKeyboardFocus({ id: selected, view: next })
        changeView(next)
        return
      }
      if (matchesShortcut(event, shortcuts.newTerminal)) {
        event.preventDefault()
        if (event.repeat) return
        add({ fromKeyboard: true })
        return
      }
      const workspaceKeys = workspaceShortcutBindings()
      if (
        event.repeat ||
        route.dialog ||
        visibleRecentSwitcher ||
        !workspaceShortcutTarget(event.target) ||
        workspaceOverlayOpen()
      )
        return
      if (matchesShortcut(event, workspaceKeys.find)) {
        event.preventDefault()
        go({ dialog: "search" })
      } else if (matchesShortcut(event, workspaceKeys.focus)) {
        const next = view === "focus" ? windowedDestination : "focus"
        if (!next || !preferences.enabledViews.includes(next)) return
        event.preventDefault()
        changeView(next)
      } else if (matchesShortcut(event, workspaceKeys.newTerminal)) {
        event.preventDefault()
        add({ fromKeyboard: true })
      } else if (matchesShortcut(event, workspaceKeys.zen)) {
        event.preventDefault()
        if (zen) exitZen()
        else enterZen()
      } else if (matchesShortcut(event, workspaceKeys.terminals)) {
        event.preventDefault()
        toggleSidebar("terminals")
      } else if (
        (event.key === "Delete" &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !event.shiftKey) ||
        matchesShortcut(event, workspaceKeys.rename)
      ) {
        const session =
          sessions.find((item) => item.id === selected) ?? (view === "focus" ? active : undefined)
        if (!session) return
        event.preventDefault()
        if (event.key === "Delete") close(session.id)
        else
          startRename(
            session,
            sidebarVisible && sidebarPanel === "terminals" ? "sidebar" : "header",
          )
      }
    }
    const keyup = (event: KeyboardEvent): void => {
      if (event.key !== "Control" || !recentSwitcher || recentSwitcher.mode !== "held") return
      if (!visibleRecentSwitcher) {
        setRecentSwitcher(null)
        return
      }
      const id = visibleRecentSwitcher.ids[visibleRecentSwitcher.index]
      setRecentSwitcher(null)
      if (id && sessions.some((session) => session.id === id)) {
        if (visibleRecentSwitcher.fromInput) setKeyboardFocus({ id, view })
        select(id)
      }
    }
    const blur = (): void => {
      if (recentSwitcher?.mode === "held") setRecentSwitcher(null)
    }
    window.addEventListener("keydown", workspaceEscape, true)
    window.addEventListener("keydown", workspaceArrows, true)
    window.addEventListener("keydown", keydown)
    window.addEventListener("keyup", keyup)
    window.addEventListener("blur", blur)
    return () => {
      window.removeEventListener("keydown", workspaceEscape, true)
      window.removeEventListener("keydown", workspaceArrows, true)
      window.removeEventListener("keydown", keydown)
      window.removeEventListener("keyup", keyup)
      window.removeEventListener("blur", blur)
    }
  })

  const sidebarRail = (mobile = false): React.JSX.Element => (
    <ToggleGroup
      className="sidebar-tools z-30 flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-shell px-1.5 py-3"
      aria-label="Sidebar actions"
      aria-hidden={Boolean(zen)}
      orientation="vertical"
      value={sidebarVisible ? [sidebarPanel] : []}
      onValueChange={(value) => {
        const next = value[0]
        if (next === "terminals" || next === "sessions") toggleSidebar(next)
        else hideSidebar()
      }}
    >
      {(
        [
          { id: "terminals", label: "Terminals", icon: TerminalIcon },
          { id: "sessions", label: "Sessions", icon: History },
        ] as const
      ).map(({ id, label, icon: Icon }) => {
        const activePanel = sidebarPanel === id && sidebarVisible
        return (
          <ToggleGroupItem
            key={id}
            tooltip={
              id === "terminals"
                ? `Terminals · ${workspaceShortcutBindings().terminals.display.join(" ")}`
                : label
            }
            value={id}
            id={`${mobile ? "mobile-" : ""}${id}-toggle`}
            className={`icon-button border ${activePanel ? "active border-line bg-paper text-ink shadow-control" : "border-transparent"}`}
            aria-label={label}
            aria-controls={`${id}-panel`}
            aria-expanded={activePanel}
          >
            <Icon size={17} />
          </ToggleGroupItem>
        )
      })}
    </ToggleGroup>
  )

  return (
    <main
      className="workspace flex h-dvh min-h-100 flex-col overflow-hidden bg-paper"
      data-zen={Boolean(zen)}
      onPointerDownCapture={cancelTerminalTransition}
      onKeyDownCapture={cancelTerminalTransition}
      style={
        {
          "--terminal-font-size": `${preferences.fontSize}px`,
        } as React.CSSProperties
      }
    >
      <WorkspaceHeader
        hidden={Boolean(zen)}
        onZen={enterZen}
        view={view}
        enabledViews={preferences.enabledViews}
        projects={projects}
        project={project}
        onProjectSelect={(id) => {
          const next = projects.find((item) => item.id === id)
          if (next) switchProject(next)
        }}
        onViewChange={(id) => {
          if (view === id) return
          const direction = viewModes.indexOf(id) > viewModes.indexOf(view) ? 1 : -1
          transitionWorkspace(() => changeView(id), direction)
        }}
        homeTo={routeUrl({ ...route, view: preferences.enabledViews[0]!, dialog: null })}
        onSearch={() => {
          setRecentSwitcher(null)
          go({ dialog: "search" })
        }}
        onPreferences={() => {
          setRecentSwitcher(null)
          go({ dialog: "preferences", section: "general" })
        }}
      />
      <div className="workspace-body relative flex min-h-0 flex-1">
        {sidebarRail()}
        <WorkspacePanels
          collapsed={Boolean(zen) || sidebarCollapsed}
          mobileOpen={!zen && sidebar}
          onMobileOpenChange={(open) => {
            if (!open) hideSidebar()
          }}
          mobileRail={sidebarRail(true)}
          mobileLabel={sidebarPanel === "sessions" ? "Workspace sessions" : "Terminal sessions"}
          mobileFinalFocusEl={() => document.getElementById(`${sidebarPanel}-toggle`)}
          sidebar={
            <aside
              id="terminal-sidebar"
              className="sidebar relative flex w-57 shrink-0 flex-col overflow-hidden border-r border-line bg-shell"
              aria-label={sidebarPanel === "sessions" ? "Workspace sessions" : "Terminal sessions"}
              aria-hidden={!sidebarVisible}
              inert={!sidebarVisible}
            >
              <SidebarPanel
                id="sessions-panel"
                title="Sessions"
                count={workspaceSessions.length}
                active={sidebarPanel === "sessions"}
                onClose={hideSidebar}
              >
                <SessionsPanel
                  key={projectId}
                  items={workspaceSessions.map((item) => {
                    const terminals = item.state.sessions
                    return {
                      id: item.id,
                      name: item.name,
                      visitedAt: item.visitedAt,
                      terminalNames: terminals.map((entry) => entry.name),
                      running: terminals.filter((entry) => entry.state === "running").length,
                    }
                  })}
                  activeId={workspaceSessionId}
                  onSelect={switchSession}
                  onFresh={startFresh}
                />
              </SidebarPanel>
              <SidebarPanel
                id="terminals-panel"
                title="Terminals"
                titleHint={`Recent · ${shortcutBindings().recent.display.join(" ")}`}
                count={sessions.length}
                active={sidebarPanel === "terminals"}
                onClose={hideSidebar}
              >
                <button
                  className={sidebarCreateClasses}
                  aria-label="New terminal"
                  onClick={() => add()}
                >
                  <Plus size={14} className="shrink-0" />
                  <span className="min-w-0 truncate">Terminal</span>
                  <kbd className="mb-[-2px] ml-auto min-h-0 shrink-0 whitespace-nowrap border-0 bg-transparent p-0 text-[9px] text-muted opacity-70">
                    {workspaceShortcutBindings().newTerminal.display.join(" ")}
                  </kbd>
                </button>
                <SessionList
                  key={`${projectId}/${workspaceSessionId}`}
                  sessions={ordered}
                  selected={selected}
                  hidden={hidden}
                  rename={renameView}
                  onVisibilityChange={setVisibility}
                  onSelect={select}
                  onBeginRename={(id) => {
                    const session = sessions.find((item) => item.id === id)
                    if (session) startRename(session, "sidebar")
                  }}
                  onRenameDraft={changeRenameDraft}
                  onRenameSave={saveRename}
                  onRenameCancel={cancelRename}
                  onClose={close}
                  onReorder={setTabOrder}
                />
              </SidebarPanel>
            </aside>
          }
        >
          <section
            key={`${projectId}/${workspaceSessionId}`}
            className={`main-area relative flex min-w-0 flex-1 flex-col ${view}`}
            aria-label={`${view} view`}
          >
            {view === "focus" && active && (
              <Focus
                sessions={sessions}
                displayed={active.id}
                onSelect={setSelected}
                render={(session) => terminal(session, false)}
              />
            )}
            {view === "grid" && (
              <Grid
                sessions={sessions}
                hidden={layoutHidden}
                preview={preview}
                selected={selected}
                onSelect={setSelected}
                navigation={navigation.count}
                presets={sizePresets.grid}
                restoreWidths={gridRestoreWidths}
                onToggleWidth={(terminalId, change) =>
                  dispatch({
                    type: "grid/size-toggle",
                    target,
                    terminalId,
                    change,
                  })
                }
                layouts={gridLayouts}
                onLayoutsChange={setGridLayouts}
                minimized={gridMinimized}
                onMinimize={(terminalId) => dispatch({ type: "grid/minimize", target, terminalId })}
                onCreate={() => {
                  add({ beginRename: false })
                }}
                render={(session, minimize, resize) =>
                  terminal(
                    session,
                    true,
                    minimize,
                    undefined,
                    resize,
                    sizePresets.grid[session.id] === "large",
                  )
                }
              />
            )}
            {view === "canvas" && (
              <Canvas
                ref={canvas}
                hidden={layoutHidden}
                preview={preview}
                presets={sizePresets.canvas}
                onPresetChange={(terminalId, preset) =>
                  dispatch({
                    type: "terminal/size-preset",
                    target,
                    terminalId,
                    view: "canvas",
                    preset,
                  })
                }
                layout={canvasLayout}
                matchCreatedTerminalRatio={Boolean(zen)}
                revealOnMount={revealCanvas}
                fitOnNavigate={navigation.fit}
                onLayoutChange={setCanvasLayout}
                sessions={sessions}
                selected={selected}
                keyboardFocusRequest={
                  canvasKeyboardFocus?.context === context && canvasKeyboardFocus.id === selected
                    ? canvasKeyboardFocus.request
                    : null
                }
                navigation={navigation.count}
                onSelect={setSelected}
                onCreate={() => add({ beginRename: false })}
                render={(session, minimize, onFlyTo, resize) =>
                  terminal(
                    session,
                    true,
                    minimize,
                    onFlyTo,
                    resize,
                    sizePresets.canvas[session.id] === "large",
                  )
                }
              />
            )}
            {view !== "focus" &&
              sessions.length > 0 &&
              sessions.every((session) => layoutHidden[session.id]) && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-center">
                  <p className="text-sm text-muted">All terminals are hidden</p>
                  <button
                    className="small-button"
                    onClick={() => sessions.forEach((session) => setVisibility(session.id, false))}
                  >
                    Show all terminals
                  </button>
                </div>
              )}
            {!sessions.length && (
              <div
                className={`empty-workspace flex min-h-0 flex-1 items-center justify-center overflow-auto p-6 text-center text-muted workspace-background ${view === "canvas" || view === "grid" ? "pointer-events-none absolute inset-0 z-10" : "relative"}`}
                {...(view === "canvas" || view === "grid" ? {} : backgroundPointerHandlers)}
              >
                {view !== "canvas" && view !== "grid" && (
                  <>
                    <div
                      className="workspace-dots absolute inset-0 canvas-grid"
                      aria-hidden="true"
                    />
                    <div
                      className="workspace-dots absolute inset-0 canvas-grid-spotlight"
                      aria-hidden="true"
                    />
                  </>
                )}
                <section className="empty-state pointer-events-auto relative z-1 flex w-full max-w-96 flex-col items-center rounded-panel border border-line bg-paper p-8 shadow-panel">
                  <span className="empty-state-icon mb-4 flex size-11 items-center justify-center rounded-control border border-line bg-shell text-muted">
                    <TerminalIcon size={22} strokeWidth={1.4} />
                  </span>
                  <h2 className="text-base font-medium tracking-tight text-ink">
                    No terminals open
                  </h2>
                  <p className="mt-2 max-w-60 text-xs leading-relaxed">
                    Open a terminal or pick up a previous session.
                  </p>
                  <div className="empty-state-actions mt-5 flex flex-wrap items-center justify-center gap-2">
                    <button
                      className="small-button primary"
                      aria-label={zen ? "Create first terminal" : "New terminal"}
                      onClick={() => add()}
                    >
                      <Plus size={14} />
                      Terminal
                    </button>
                    <button
                      className="empty-sessions-link rounded-control px-3 py-2 text-[11px] text-muted hover:bg-soft hover:text-ink"
                      onClick={showSessions}
                    >
                      Browse sessions
                    </button>
                  </div>
                </section>
              </div>
            )}
          </section>
        </WorkspacePanels>
        {zen && (
          <ZenDock
            view={view}
            enabledViews={preferences.enabledViews}
            onCreate={() => add()}
            onViewChange={(next) => {
              if (next !== view) changeView(next)
            }}
            onExit={exitZen}
          />
        )}
      </div>
      <footer
        hidden={Boolean(zen)}
        className="app-footer max-[701px]:px-3 max-[701px]:text-[8px] flex h-7 shrink-0 items-center justify-between border-t border-line bg-paper px-4 text-[10px] text-muted"
      >
        <span className="flex items-center gap-2">
          <span>
            {sessions.length} {sessions.length === 1 ? "terminal" : "terminals"}
          </span>
          <span className="footer-running max-[701px]:hidden ml-2 border-l border-line pl-3">
            {sessions.filter((session) => session.state === "running").length} running
          </span>
        </span>
      </footer>
      {visibleRecentSwitcher && (
        <TerminalSwitcher
          mode={visibleRecentSwitcher.mode}
          project={project.name}
          onClose={closeRecentSwitcher}
          onSelect={(id) => {
            setRecentSwitcher(null)
            if (visibleRecentSwitcher.mode === "click") setKeyboardFocus({ id, view })
            select(id)
          }}
          sessions={visibleRecentSwitcher.ids.flatMap((id) => {
            const session = sessions.find((item) => item.id === id)
            return session ? [session] : []
          })}
          selected={visibleRecentSwitcher.ids[visibleRecentSwitcher.index]}
        />
      )}
      <TerminalSearch
        onExitComplete={onExitComplete}
        open={searching}
        key={`${projectId}/${workspaceSessionId}`}
        sessions={ordered}
        destination={searchLabel}
        onSelect={openSearchResult}
        onClose={closeDialog}
      />
      <Preferences
        key={`preferences/${projectId}/${workspaceSessionId}`}
        onExitComplete={onExitComplete}
        open={settings}
        value={preferences}
        tab={route.section}
        onTabChange={(section) => go({ section })}
        onChange={updatePreferences}
        onClose={closeDialog}
      />
    </main>
  )
}
