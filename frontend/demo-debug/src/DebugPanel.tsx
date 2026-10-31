// The demo's debug panel: puts the demo in the states the real backend can be in, for
// manual checks. It is a drawer kept below the page's bottom edge, a small handle at the
// bottom middle peeking out; the handle slides it up and back down. Its groups sit under
// their sections, folded until opened; a search finds an action by its words. See
// docs/development.md, "Debug panel".
import "./debug-panel.css"
import type { BackendConnectionState, BackendSink, TerminalKey } from "@novadeck/core/port"
import type { Workspace } from "@novadeck/core/types"
import { demoVariants } from "@novadeck/demo/variants"
import { Bug, ChevronDown, ChevronRight, ChevronUp, RotateCcw, Search, X } from "lucide-react"
import { useEffect, useRef, useState, useSyncExternalStore, type ComponentType } from "react"

import type { DemoLaunch, DemoShell } from "./debug-demo"
import { portableGroup } from "./desktop/portable"
import { uninstallGroup } from "./desktop/uninstall"
import { shellGroups } from "./shell-groups"
import {
  demoSections,
  demoTargets,
  type DemoAction,
  type DemoActionContext,
  type DemoActionGroup,
  type DemoStates,
  type DemoTarget,
} from "./types"

// The connection chip's tone: none while connected.
const connectionTone = (connection: BackendConnectionState) =>
  connection === "connected" ? undefined : connection === "reconnecting" ? "warning" : "danger"

// The variants the header switches between; the welcome one is the Welcome dialog's, and
// Chirp's, Babcia's and Launch's are one-offs for videos, opened with `?demo=` and their names.
const variantItems = demoVariants.filter(
  (variant) =>
    variant !== "welcome" && variant !== "chirp" && variant !== "babcia" && variant !== "launch",
)

// The groups opened in this tab, kept across the demo's boots, which remount the panel.
const openedKey = "novadeck.debug-panel.opened"
const readOpened = (): ReadonlySet<string> => {
  try {
    const stored: unknown = JSON.parse(window.sessionStorage.getItem(openedKey) ?? "[]")
    return new Set(Array.isArray(stored) ? stored.filter((each) => typeof each === "string") : [])
  } catch {
    return new Set()
  }
}
const keepOpened = (opened: ReadonlySet<string>): void => {
  try {
    window.sessionStorage.setItem(openedKey, JSON.stringify([...opened]))
  } catch {
    // Without storage, the groups fold again at the next boot.
  }
}

// The target of the agent actions chosen in this tab, kept the same way.
const targetKey = "novadeck.debug-panel.target"
const targetLabels: Record<DemoTarget, string> = {
  selected: "Selected",
  terminal: "Other terminal",
  project: "Other project",
}
const readTarget = (): DemoTarget => {
  try {
    const stored = window.sessionStorage.getItem(targetKey)
    return demoTargets.find((each) => each === stored) ?? "selected"
  } catch {
    return "selected"
  }
}
const keepTarget = (target: DemoTarget): void => {
  try {
    window.sessionStorage.setItem(targetKey, target)
  } catch {
    // Without storage, the target is the selected terminal again at the next boot.
  }
}

// Whether an action has every word of the search in its group, label or hint.
const matches = (words: readonly string[], group: DemoActionGroup, action: DemoAction) => {
  const text = `${group.title} ${action.label} ${action.hint}`.toLowerCase()
  return words.every((word) => text.includes(word))
}

// What the debug panel may ask of the workspace.
type DebugPanelProps = {
  // Adds a terminal to the current session and returns its key.
  readonly addTerminal: () => TerminalKey
  readonly startFresh: () => void
  readonly selected: () => TerminalKey | undefined
  readonly select: (key: TerminalKey) => void
}

export type DebugPanel = ComponentType<DebugPanelProps>

export const createDebugPanel = ({
  launch,
  shell,
  states,
  dispatch,
  workspace,
  addInBackground,
}: {
  readonly launch: DemoLaunch
  readonly shell: DemoShell
  readonly states: DemoStates
  readonly dispatch: () => BackendSink["dispatch"] | undefined
  readonly workspace: () => Workspace | undefined
  readonly addInBackground: DemoActionContext["addInBackground"]
}): DebugPanel => {
  const { Notices } = states
  const DebugPanel = ({
    addTerminal,
    startFresh,
    selected,
    select,
  }: DebugPanelProps): React.JSX.Element => {
    const [open, setOpen] = useState(false)
    const [terminals, setTerminals] = useState(shell.terminals)
    // Each note counts up, so one that repeats re-renders its text and is announced again.
    const [noted, setNoted] = useState({ text: "", n: 0 })
    const note = noted.text
    const setNote = (text: string): void => setNoted((last) => ({ text, n: last.n + 1 }))
    const [query, setQuery] = useState("")
    const [opened, setOpened] = useState(readOpened)
    const [target, setTarget] = useState(readTarget)
    const toggle = useRef<HTMLButtonElement>(null)
    const search = useRef<HTMLInputElement>(null)
    const body = useRef<HTMLDivElement>(null)
    const connection = useSyncExternalStore(
      shell.connection.subscribe,
      shell.connection.getSnapshot,
    )
    const crashes = useSyncExternalStore(shell.crashes.subscribe, shell.crashes.getSnapshot)

    useEffect(() => {
      if (!open) return
      search.current?.focus()
      const timer = setInterval(() => setTerminals(shell.terminals()), 500)
      return () => clearInterval(timer)
    }, [open])

    // Escape in the panel, or on its handle, closes it and returns to the handle; in a
    // search with words, it clears them first.
    const closeOnEscape = (event: React.KeyboardEvent): void => {
      if (event.key !== "Escape" || !open) return
      event.preventDefault()
      if (event.target === search.current && query) return setQuery("")
      setOpen(false)
      toggle.current?.focus()
    }

    const context = (): DemoActionContext => ({
      target,
      selected,
      select,
      addTerminal,
      addInBackground,
      startFresh,
      dispatch: dispatch(),
      workspace,
      note: setNote,
    })
    const groups = [
      ...shellGroups({ launch, shell, states }),
      portableGroup(launch),
      uninstallGroup(launch),
      ...states.groups,
    ]
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const searching = words.length > 0
    // While searching, every group with a match shows it, opened or not.
    const sections = demoSections
      .map((section) => ({
        section,
        groups: groups
          .filter((group) => group.section === section)
          .map((group) => ({
            ...group,
            shown: searching
              ? group.actions.filter((action) => matches(words, group, action))
              : group.actions,
          }))
          .filter((group) => !searching || group.shown.length > 0),
      }))
      .filter((each) => each.groups.length > 0)
    const fold = (title: string): void => {
      const next = new Set(opened)
      if (!next.delete(title)) next.add(title)
      keepOpened(next)
      setOpened(next)
    }
    const run = (action: DemoAction): void => {
      setNote("")
      void Promise.resolve(action.run(context())).catch((error: unknown) => setNote(String(error)))
    }
    // Mounted while closed too: the handle, and where the demo's notifications appear.
    // The drawer stays mounted, so it slides both ways; closed, it is inert below the edge.
    return (
      <>
        <Notices />
        <div
          className="debug-drawer pointer-events-none fixed inset-x-0 bottom-0 z-50 mx-auto flex w-100 max-w-[calc(100vw-2.5rem)] flex-col items-center"
          data-open={open || undefined}
        >
          <button
            ref={toggle}
            type="button"
            aria-expanded={open}
            aria-controls="debug-panel"
            aria-label={open ? "Close the debug panel" : "Open the debug panel"}
            className="debug-handle pointer-events-auto relative z-1 flex h-6 items-center gap-1.5 px-3 text-caption font-medium"
            data-own-keys
            onKeyDown={closeOnEscape}
            onClick={() => {
              setTerminals(shell.terminals())
              setOpen((value) => !value)
            }}
          >
            <Bug size={14} aria-hidden />
            <span className="debug-handle-label">Debug</span>
            {open ? (
              <ChevronDown size={12} aria-hidden className="debug-handle-chevron" />
            ) : (
              <ChevronUp size={12} aria-hidden className="debug-handle-chevron" />
            )}
          </button>
          {/* After its handle, so Tab goes on from the handle into the panel. */}
          <aside
            id="debug-panel"
            aria-label="Debug panel"
            inert={!open}
            // Its keys are its own (see interaction/dom.ts): the workspace leaves them
            // alone, and a click here keeps focus here.
            data-own-keys
            // Focusable, so a click off its controls lands focus here and Escape still
            // closes it.
            tabIndex={-1}
            onKeyDown={closeOnEscape}
            className="debug-panel pointer-events-auto flex h-[min(760px,calc(100vh-80px))] w-full flex-col"
          >
            <header className="debug-panel-header flex flex-col gap-3 px-4 pt-4 pb-3">
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="debug-panel-mark flex size-8 shrink-0 items-center justify-center"
                >
                  <Bug size={16} />
                </span>
                <h2 className="m-0 flex-1 text-lead leading-none font-semibold">Debug</h2>
                <p className="m-0 flex flex-wrap justify-end gap-1.5 text-caption">
                  <span className="debug-chip px-1.5 py-0.5" data-tone={connectionTone(connection)}>
                    {connection}
                  </span>
                  <span
                    className="debug-chip px-1.5 py-0.5"
                    data-tone={crashes ? "danger" : undefined}
                  >
                    {crashes} {crashes === 1 ? "crash" : "crashes"}
                  </span>
                  <span className="debug-chip px-1.5 py-0.5">
                    {terminals} {terminals === 1 ? "terminal" : "terminals"}
                  </span>
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span aria-hidden className="debug-label w-10 shrink-0 text-caption">
                  Demo
                </span>
                {/* Buttons, not a radio group: each boots the demo again into its variant,
                    the current one included, so arrow keys mustn't choose. */}
                <div
                  role="group"
                  aria-label="Demo"
                  className="segmented flex min-w-0 flex-1 gap-0.5"
                >
                  {variantItems.map((variant) => (
                    <button
                      key={variant}
                      type="button"
                      aria-pressed={variant === launch.variant}
                      title={
                        variant === launch.variant
                          ? "Boots this demo again"
                          : "Boots the demo again into it"
                      }
                      className="segment flex h-6 flex-1 items-center justify-center px-1.5 text-control"
                      onClick={() => launch.switchVariant(variant)}
                    >
                      {variant}
                    </button>
                  ))}
                </div>
              </div>
              <label className="debug-search field flex h-8 items-center gap-2 px-2.5">
                <Search size={14} aria-hidden className="field-indicator shrink-0" />
                <input
                  ref={search}
                  type="search"
                  aria-label="Find a state"
                  placeholder="Find a state…"
                  autoComplete="off"
                  spellCheck={false}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowDown") return
                    event.preventDefault()
                    // The first group toggle or action in order; the toggles are disabled while searching.
                    body.current
                      ?.querySelector<HTMLElement>(".debug-group:not(:disabled), .debug-action")
                      ?.focus()
                  }}
                  className="field-input min-w-0 flex-1 text-body"
                />
                {query && (
                  <button
                    type="button"
                    aria-label="Clear the search"
                    className="debug-search-clear flex size-5 shrink-0 items-center justify-center"
                    onClick={() => {
                      setQuery("")
                      search.current?.focus()
                    }}
                  >
                    <X size={12} aria-hidden />
                  </button>
                )}
              </label>
            </header>
            <div
              ref={body}
              className="debug-panel-body min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-2"
            >
              {sections.map(({ section, groups: grouped }) => (
                <section key={section} aria-label={section} className="flex flex-col">
                  <h3 className="debug-section m-0 px-2 pt-3 pb-1 text-caption font-semibold">
                    {section}
                  </h3>
                  {grouped.map((group) => {
                    const shown = searching || opened.has(group.title)
                    return (
                      <div key={group.title} className="flex flex-col">
                        <button
                          type="button"
                          aria-expanded={shown}
                          disabled={searching}
                          className="debug-group flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-body font-medium"
                          onClick={() => fold(group.title)}
                        >
                          <ChevronRight size={12} aria-hidden className="debug-group-chevron" />
                          <span className="flex-1">{group.title}</span>
                          <span className="debug-group-count text-caption">
                            {searching
                              ? `${group.shown.length} of ${group.actions.length}`
                              : group.actions.length}
                          </span>
                        </button>
                        {shown && (
                          <div className="flex flex-col gap-0.5 pb-1.5 pl-3.5">
                            {group.targets && (
                              <div
                                role="group"
                                aria-label="Target"
                                className="segmented flex gap-0.5 px-2.5 pb-1"
                              >
                                {demoTargets.map((each) => (
                                  <button
                                    key={each}
                                    type="button"
                                    aria-pressed={each === target}
                                    className="segment flex h-6 flex-1 items-center justify-center px-1.5 text-control"
                                    onClick={() => {
                                      keepTarget(each)
                                      setTarget(each)
                                    }}
                                  >
                                    {targetLabels[each]}
                                  </button>
                                ))}
                              </div>
                            )}
                            {group.shown.map((action) => (
                              <button
                                key={action.label}
                                type="button"
                                className="debug-action flex flex-col items-start gap-0.5 px-2.5 py-1.5 text-left"
                                onClick={() => run(action)}
                              >
                                <span className="flex items-center gap-1.5 text-body font-medium">
                                  {action.label}
                                  {action.reboots && (
                                    <span
                                      className="debug-reboots flex items-center"
                                      title="Boots the demo again"
                                    >
                                      <RotateCcw size={12} aria-hidden />
                                      <span className="sr-only">(boots the demo again)</span>
                                    </span>
                                  )}
                                </span>
                                <span className="debug-hint text-caption">{action.hint}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </section>
              ))}
              {searching && sections.length === 0 && (
                <p className="debug-hint m-0 px-2 py-6 text-center text-body">
                  No state matches “{query.trim()}”.
                </p>
              )}
            </div>
            {/* Mounted while empty too, so a note that comes up is announced. */}
            <p
              role="status"
              className={note ? "debug-panel-note m-0 px-4 py-2 text-control" : "sr-only"}
            >
              <span key={noted.n}>{note}</span>
            </p>
          </aside>
        </div>
      </>
    )
  }
  return DebugPanel
}
