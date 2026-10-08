import "./demo.css"
import { GitBranch } from "lucide-react"
import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react"

import { endingText, terminalEnding } from "../../model/terminal-ending"
import type { TerminalMetadata } from "../../model/types"
import { TerminalEndingBar, TerminalLock, TerminalNotice } from "../../ui-toolkit/TerminalStatus"
import type { BackendConnectionState, TerminalKey, TerminalSurfaceProps } from "../port"
import { terminalKeyId } from "../registry"
import type { DemoScreen, DemoSurfaceRuntime } from "./debug/types"
import type { DemoEngine, DemoTerminalSnapshot } from "./engine"
import { demoAgent, demoAgents } from "./samples"
import { TerminalOutput } from "./TerminalOutput"

type DemoTerminalSurfaceProps = Omit<TerminalSurfaceProps, "terminalKey" | "renderWindow"> &
  DemoTerminalSnapshot & {
    onCommand: (command: string) => void
    onDraftChange: (draft: string) => void
    onScrollChange: (offset: number) => void
    // What the terminal opens with, instead of the sample output for its program.
    intro: ReactNode
    // The far side being there to type into and starting a fresh shell, where the demo
    // models them: its surface then locks and shows how a shell ended.
    session?: {
      readonly locked: boolean
      readonly lockNotice: string
      // Shown for a moment at the top, as a failed paste's.
      readonly notice: string | undefined
      readonly restart: () => void
    }
  }

const DemoTerminalSurface = ({
  terminal,
  projectName,
  entries,
  cleared,
  onCommand,
  draft,
  onDraftChange,
  scrollOffset,
  onScrollChange,
  focusInput,
  onInputFocused,
  intro,
  session,
}: DemoTerminalSurfaceProps): React.JSX.Element => {
  const agent = demoAgent(terminal)
  const input = draft
  const setInput = onDraftChange
  const savedScroll = useRef(scrollOffset)
  const previousOutput = useRef({ length: entries.length, cleared })
  const output = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const ending = session ? terminalEnding(terminal) : null
  const commandInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!focusInput || !commandInput.current) return
    commandInput.current.focus({ preventScroll: true })
    onInputFocused()
  }, [focusInput, onInputFocused])
  useEffect(() => {
    if (!output.current) return
    const changed =
      previousOutput.current.length !== entries.length || previousOutput.current.cleared !== cleared
    output.current.scrollTop = changed
      ? output.current.scrollHeight
      : (savedScroll.current ?? (entries.length || cleared ? output.current.scrollHeight : 0))
    previousOutput.current = { length: entries.length, cleared }
  }, [entries.length, cleared])
  useEffect(() => {
    const element = frame.current ?? output.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      // Intercept before XYFlow's native listener, but let zoom gestures reach it.
      if (!event.ctrlKey && !event.metaKey) event.stopPropagation()
    }
    element.addEventListener("wheel", onWheel, { passive: true })
    return () => element.removeEventListener("wheel", onWheel)
  }, [])
  // The root the rest of the UI relies on (see TerminalSurfaceProps). With a session it
  // frames the output, so the lock and the ending bar stay put while the output scrolls.
  const root = {
    "data-terminal-content": "",
  }
  const scroller = (
    <div
      ref={output}
      {...(session ? {} : root)}
      className={`terminal-content demo-output min-h-0 flex-1 overflow-auto [&_strong]:font-semibold${session ? "" : " nodrag nopan"}${ending ? " mb-7" : ""}`}
      onScroll={(event) => {
        savedScroll.current = event.currentTarget.scrollTop
        onScrollChange(event.currentTarget.scrollTop)
      }}
    >
      {!cleared && (intro ?? <TerminalOutput terminal={terminal} projectName={projectName} />)}
      {entries.map((entry) => (
        <div className="output-gap" key={entry.id}>
          <p>
            <span className="prompt-arrow mr-2 font-semibold">❯</span> {entry.command}
          </p>
          <p className="whitespace-pre-wrap muted">{entry.reply}</p>
        </div>
      ))}
      <form
        className={`command-form p-3${agent ? " agent-command-form max-w-180" : ""}`}
        onSubmit={(event) => {
          event.preventDefault()
          if (session?.locked) return
          if (ending) return session?.restart()
          if (input.trim()) {
            onCommand(input)
            setInput("")
          }
        }}
      >
        {!agent && (
          <div className="command-location mb-1 flex items-center gap-2 text-caption [&>svg]:ml-1">
            <span>{projectName}</span>
            <GitBranch size={12} />
            <span>main</span>
          </div>
        )}
        <label className="command-line flex items-center [&_input]:w-full [&_input]:flex-1">
          <span className="prompt-arrow mr-2 font-semibold">❯</span>
          <input
            ref={commandInput}
            data-terminal-input
            aria-label={`Command for ${terminal.name}`}
            autoComplete="off"
            spellCheck={false}
            value={input}
            aria-disabled={session?.locked || undefined}
            onChange={(event) => {
              if (!session?.locked) setInput(event.target.value)
            }}
            placeholder={agent ? `Message ${demoAgents[agent]}…` : ""}
          />
        </label>
      </form>
    </div>
  )
  if (!session) return scroller
  return (
    <>
      <div
        ref={frame}
        {...root}
        className="terminal-content relative flex min-h-0 flex-1 flex-col p-0 nodrag nopan"
        data-locked={session.locked || undefined}
      >
        {scroller}
        <TerminalEndingBar
          ending={ending}
          paused={session.locked}
          onRestart={() => {
            session.restart()
            commandInput.current?.focus({ preventScroll: true })
          }}
        />
        {session.notice && (
          <div
            aria-hidden
            data-paste-notice
            className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3"
          >
            <TerminalNotice notice={session.notice} />
          </div>
        )}
        {session.locked && <TerminalLock notice={session.lockNotice} />}
      </div>
      {/* Announced from outside the frame: it is inert while hidden. Empty while no
          ending shows, so a repeat of the same ending is announced again. */}
      <span aria-live="polite" aria-atomic className="sr-only">
        {ending ? endingText(ending) : ""}
      </span>
      <span aria-live="polite" aria-atomic className="sr-only">
        {session.notice ?? ""}
      </span>
    </>
  )
}

const ignore = (): (() => void) => () => {}
const connected = (): BackendConnectionState => "connected"
const showing: DemoScreen = {}
const noScreens: ReadonlyMap<string, DemoScreen> = new Map()
const none = (): ReadonlyMap<string, DemoScreen> => noScreens

// Why typing is paused, as the runner's surface says it: the far side away, a shell still
// starting, or a screen on its way.
const lockNotice = (
  connection: BackendConnectionState,
  terminal: TerminalMetadata,
  screen: DemoScreen,
): string | undefined => {
  if (connection === "reconnecting") return "Reconnecting…"
  if (connection === "unavailable") return "Runner offline"
  if (terminal.state === "starting") return "Starting shell…"
  return screen.attaching ? "Loading output…" : undefined
}

// One component per engine, so its identity stays stable while the backend lives.
// `introOf` gives a terminal its own opening output, when it has one.
export const createDemoTerminal = (
  engine: DemoEngine,
  introOf?: (terminal: TerminalMetadata, key: TerminalKey) => ReactNode,
  runtime?: DemoSurfaceRuntime,
) => {
  const DemoTerminal = ({
    terminalKey,
    renderWindow,
    ...props
  }: TerminalSurfaceProps): React.JSX.Element => {
    const { projectId, workspaceSessionId, terminalId } = terminalKey
    const subscribe = useCallback(
      (listener: () => void) =>
        engine.subscribe({ projectId, workspaceSessionId, terminalId }, listener),
      [projectId, workspaceSessionId, terminalId],
    )
    const getSnapshot = useCallback(
      () => engine.getSnapshot({ projectId, workspaceSessionId, terminalId }),
      [projectId, workspaceSessionId, terminalId],
    )
    const snapshot = useSyncExternalStore(subscribe, getSnapshot)
    const connection = useSyncExternalStore(
      runtime?.connection.subscribe ?? ignore,
      runtime?.connection.getSnapshot ?? connected,
    )
    const screens = useSyncExternalStore(
      runtime?.screens.subscribe ?? ignore,
      runtime?.screens.getSnapshot ?? none,
    )
    const key = { projectId, workspaceSessionId, terminalId }
    const screen = screens.get(terminalKeyId(key)) ?? showing
    const locked = lockNotice(connection, props.terminal, screen)
    const content = (
      <DemoTerminalSurface
        {...props}
        {...snapshot}
        onDraftChange={(draft) => engine.setDraft(key, draft)}
        onScrollChange={(offset) => engine.setScrollOffset(key, offset)}
        onCommand={(command) => engine.run(key, command)}
        intro={introOf?.(props.terminal, key)}
        {...(runtime && {
          session: {
            locked: locked !== undefined,
            lockNotice: locked ?? "",
            notice: screen.notice,
            restart: () => runtime.restart(key),
          },
        })}
      />
    )
    return <>{renderWindow(content)}</>
  }
  return DemoTerminal
}
