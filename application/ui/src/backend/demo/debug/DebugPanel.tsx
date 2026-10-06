// The demo's debug panel: puts the demo in the states the real backend can be in, for
// manual checks. A round button floating at the page's bottom right opens it, as dev
// toolbars do, and the panel rises out of it; see README "Debug panel".
import "./debug-panel.css"
import { Bug, ChevronRight, X } from "lucide-react"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"

import type { Workspace } from "../../../model/types"
import type { BackendConnectionState, BackendSink, DebugPanelProps } from "../../port"
import { shellGroups } from "./shell-groups"
import type { DemoActionContext, DemoStates } from "./types"
import type { DemoLaunch, DemoShell } from "./with-debug"

// The connection chip's tone: none while connected.
const connectionTone = (connection: BackendConnectionState) =>
  connection === "connected" ? undefined : connection === "reconnecting" ? "warning" : "danger"

export const createDebugPanel = ({
  launch,
  shell,
  states,
  dispatch,
  workspace,
}: {
  readonly launch: DemoLaunch
  readonly shell: DemoShell
  readonly states: DemoStates
  readonly dispatch: () => BackendSink["dispatch"] | undefined
  readonly workspace: () => Workspace | undefined
}) => {
  const { Notices } = states
  const DebugPanel = ({
    addTerminal,
    startFresh,
    selected,
  }: DebugPanelProps): React.JSX.Element => {
    const [open, setOpen] = useState(false)
    const [terminals, setTerminals] = useState(shell.terminals)
    const [note, setNote] = useState("")
    // The groups the person folded, kept while the demo runs.
    const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
    const toggle = useRef<HTMLButtonElement>(null)
    const connection = useSyncExternalStore(
      shell.connection.subscribe,
      shell.connection.getSnapshot,
    )
    const crashes = useSyncExternalStore(shell.crashes.subscribe, shell.crashes.getSnapshot)

    useEffect(() => {
      if (!open) return
      const timer = setInterval(() => setTerminals(shell.terminals()), 500)
      return () => clearInterval(timer)
    }, [open])

    // Escape in the panel, or on its button, closes it and returns to the button.
    const closeOnEscape = (event: React.KeyboardEvent): void => {
      if (event.key !== "Escape" || !open) return
      event.preventDefault()
      setOpen(false)
      toggle.current?.focus()
    }

    const context = (): DemoActionContext => ({
      selected,
      addTerminal,
      startFresh,
      dispatch: dispatch(),
      workspace,
      note: setNote,
    })
    const groups = [...shellGroups({ launch, shell, states }), ...states.groups]
    const fold = (title: string): void =>
      setFolded((previous) => {
        const next = new Set(previous)
        if (!next.delete(title)) next.add(title)
        return next
      })
    // Mounted while closed too: the button, and where the demo's notifications appear.
    return (
      <>
        <Notices />
        <button
          ref={toggle}
          type="button"
          aria-expanded={open}
          aria-controls="debug-panel"
          aria-label={open ? "Close the debug panel" : "Open the debug panel"}
          className="debug-floater fixed right-5 bottom-12 z-50 flex size-12 items-center justify-center"
          data-own-keys
          onKeyDown={closeOnEscape}
          onClick={() => {
            setTerminals(shell.terminals())
            setOpen((value) => !value)
          }}
        >
          {open ? <X size={20} aria-hidden /> : <Bug size={22} aria-hidden />}
        </button>
        {/* After its button, so Tab goes on from the button into the panel. */}
        {open && (
          <aside
            id="debug-panel"
            aria-label="Debug panel"
            // Its keys are its own (see interaction/dom.ts): the workspace leaves them
            // alone, and a click here keeps focus here.
            data-own-keys
            // Focusable, so a click off its controls lands focus here and Escape still
            // closes it.
            tabIndex={-1}
            onKeyDown={closeOnEscape}
            className="debug-panel fixed right-5 bottom-[110px] z-50 flex max-h-[min(720px,calc(100vh-170px))] w-100 max-w-[calc(100vw-2.5rem)] flex-col"
          >
            <header className="debug-panel-header flex items-start gap-3 px-4 pt-4 pb-3">
              <span
                aria-hidden
                className="debug-panel-mark flex size-8 shrink-0 items-center justify-center"
              >
                <Bug size={16} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <h2 className="m-0 text-[13px] leading-none font-semibold">Debug</h2>
                <p className="m-0 flex flex-wrap gap-1.5 text-[10px]">
                  <span className="debug-chip px-1.5 py-0.5">{launch.variant}</span>
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
            </header>
            <div className="debug-panel-body min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {groups.map(({ title, actions }) => {
                const shown = !folded.has(title)
                return (
                  <section key={title} className="flex flex-col">
                    <button
                      type="button"
                      aria-expanded={shown}
                      className="debug-group flex w-full items-center gap-1.5 px-2 py-2 text-left text-[10px] font-semibold"
                      onClick={() => fold(title)}
                    >
                      <ChevronRight size={12} aria-hidden className="debug-group-chevron" />
                      <span className="flex-1">{title}</span>
                      <span className="debug-group-count font-normal">{actions.length}</span>
                    </button>
                    {shown && (
                      <div className="flex flex-col gap-0.5 pb-2">
                        {actions.map((action) => (
                          <button
                            key={action.label}
                            type="button"
                            className="debug-action flex flex-col items-start gap-0.5 px-2.5 py-1.5 text-left"
                            onClick={() => {
                              setNote("")
                              void Promise.resolve(action.run(context())).catch((error: unknown) =>
                                setNote(String(error)),
                              )
                            }}
                          >
                            <span className="text-[12px] font-medium">{action.label}</span>
                            <span className="debug-hint text-[10px] leading-[1.4]">
                              {action.hint}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
            {note && (
              <p role="status" className="debug-panel-note m-0 px-4 py-2 text-[11px]">
                {note}
              </p>
            )}
            {/* Points down at the button the panel rose out of. */}
            <span aria-hidden className="debug-panel-tail absolute right-4.5 -bottom-1.5 size-3" />
          </aside>
        )}
      </>
    )
  }
  return DebugPanel
}
