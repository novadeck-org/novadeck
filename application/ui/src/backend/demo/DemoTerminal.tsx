import "./demo.css"
import { GitBranch } from "lucide-react"
import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react"

import type { TerminalMetadata } from "../../model/types"
import type { TerminalSurfaceProps } from "../port"
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
  minimized,
  clipContent,
  intro,
}: DemoTerminalSurfaceProps): React.JSX.Element => {
  const agent = demoAgent(terminal)
  const input = draft
  const setInput = onDraftChange
  const savedScroll = useRef(scrollOffset)
  const previousOutput = useRef({ length: entries.length, cleared })
  const output = useRef<HTMLDivElement>(null)
  const commandInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!focusInput || !commandInput.current) return
    commandInput.current.focus({ preventScroll: true })
    onInputFocused()
  }, [focusInput, onInputFocused])
  useEffect(() => {
    if (!output.current || minimized) return
    const changed =
      previousOutput.current.length !== entries.length || previousOutput.current.cleared !== cleared
    output.current.scrollTop = changed
      ? output.current.scrollHeight
      : (savedScroll.current ?? (entries.length || cleared ? output.current.scrollHeight : 0))
    previousOutput.current = { length: entries.length, cleared }
  }, [entries.length, cleared, minimized])
  useEffect(() => {
    const element = output.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      // Intercept before XYFlow's native listener, but let zoom gestures reach it.
      if (!event.ctrlKey && !event.metaKey) event.stopPropagation()
    }
    element.addEventListener("wheel", onWheel, { passive: true })
    return () => element.removeEventListener("wheel", onWheel)
  }, [])
  return (
    <div
      ref={output}
      data-terminal-content
      className="terminal-content min-h-0 flex-1 overflow-auto p-6 font-mono text-[length:var(--terminal-font-size,13px)] leading-[1.75] [&_strong]:font-semibold nodrag nopan"
      hidden={minimized && !clipContent}
      aria-hidden={minimized}
      inert={minimized}
      onScroll={(event) => {
        if (minimized) return
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
          <p className="whitespace-pre-wrap text-muted">{entry.reply}</p>
        </div>
      ))}
      <form
        className={`command-form mt-6 rounded-control border border-line bg-shell p-3 transition-[border-color] duration-(--motion-state) ease-interface focus-within:border-line-strong${agent ? " agent-command-form max-w-180 [&_input]:placeholder:text-muted" : ""}`}
        onSubmit={(event) => {
          event.preventDefault()
          if (input.trim()) {
            onCommand(input)
            setInput("")
          }
        }}
      >
        {!agent && (
          <div className="command-location mb-1 flex items-center gap-2 text-[10px] text-muted [&>svg]:ml-1 [&>svg]:text-muted">
            <span>{projectName}</span>
            <GitBranch size={12} />
            <span className="text-muted">main</span>
          </div>
        )}
        <label className="command-line flex items-center border-b border-transparent transition-[border-color] duration-(--motion-state) ease-interface focus-within:border-b-line [&_input]:w-full [&_input]:flex-1 [&_input]:bg-transparent [&_input]:caret-ink [&_input:focus-visible]:outline-none">
          <span className="prompt-arrow mr-2 font-semibold">❯</span>
          <input
            ref={commandInput}
            data-terminal-input
            aria-label={`Command for ${terminal.name}`}
            autoComplete="off"
            spellCheck={false}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={agent ? `Message ${demoAgents[agent]}…` : ""}
          />
        </label>
      </form>
    </div>
  )
}

// One component per engine, so its identity stays stable while the backend lives.
// `introOf` gives a terminal its own opening output, when it has one.
export const createDemoTerminal = (
  engine: DemoEngine,
  introOf?: (terminal: TerminalMetadata) => ReactNode,
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
    const key = { projectId, workspaceSessionId, terminalId }
    const content = (
      <DemoTerminalSurface
        {...props}
        {...snapshot}
        onDraftChange={(draft) => engine.setDraft(key, draft)}
        onScrollChange={(offset) => engine.setScrollOffset(key, offset)}
        onCommand={(command) => engine.run(key, command)}
        intro={introOf?.(props.terminal)}
      />
    )
    return <>{renderWindow(content)}</>
  }
  return DemoTerminal
}
