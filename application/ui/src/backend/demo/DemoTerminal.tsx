import "./demo.css"
import { GitBranch } from "lucide-react"
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import { noConversation, type ChatDialog, type Conversation } from "../../model/conversation"
import { terminalLabel } from "../../model/handle"
import { endingText, terminalEnding } from "../../model/terminal-ending"
import type { TerminalMetadata } from "../../model/types"
import { TerminalEndingBar, TerminalLock, TerminalNotice } from "../../ui-toolkit/TerminalStatus"
import type { BackendConnectionState, TerminalKey, TerminalSurfaceProps } from "../port"
import { terminalKeyId } from "../registry"
import { readLine, shownRequest, withWords } from "./agent-input"
import { DemoAgentContext, type DemoAgentLink } from "./agent-link"
import { AgentScreen, tailOf } from "./AgentScreen"
import type { DemoEngine, DemoTerminalSnapshot } from "./engine"
import { chatAgent, chatAgents, demoAgent } from "./samples"
import type { DemoScreen, DemoSurfaceRuntime } from "./surface"
import { TerminalOutput } from "./TerminalOutput"

type DemoTerminalSurfaceProps = Omit<TerminalSurfaceProps, "terminalKey" | "renderWindow"> &
  DemoTerminalSnapshot & {
    onCommand: (command: string) => void
    onDraftChange: (draft: string) => void
    onScrollChange: (offset: number | "end") => void
    // Where the terminal's agent is read and answered, where the demo links its screen
    // to it: its conversation then follows the intro, and the command line talks to it.
    link?: { readonly agent: DemoAgentLink; readonly key: TerminalKey }
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

type QuestionAnswers = Parameters<typeof readLine>[2]

// A dialog by what an answer names it with; a raw one has no id and is never answered.
const dialogId = (dialog: ChatDialog | null): string => (dialog && "id" in dialog ? dialog.id : "")

const DemoTerminalSurface = ({
  terminal,
  projectName,
  entries,
  cleared,
  opening,
  onCommand,
  draft,
  onDraftChange,
  scrollOffset,
  onScrollChange,
  focusInput,
  onInputFocused,
  intro,
  session,
  link,
}: DemoTerminalSurfaceProps): React.JSX.Element => {
  const live = link && chatAgent(terminal)
  const status = terminal.state === "running" ? terminal.agent : undefined
  const agent = live ?? demoAgent(terminal)
  const store = useMemo(
    () => (link && live ? link.agent.conversations.conversation(link.key) : undefined),
    [link, live],
  )
  const conversation = useSyncExternalStore(store?.subscribe ?? ignore, store?.getSnapshot ?? idle)
  const request = live ? shownRequest(conversation.requests) : undefined
  const tail =
    link && live
      ? tailOf(live, conversation, link.agent.opening(link.key), status, request)
      : undefined
  // The questions of a dialog taken so far, and a line the screen couldn't take.
  const [taken, setTaken] = useState<{
    dialog: string
    answers: QuestionAnswers
  }>()
  // A note belongs to the request that was shown when it came up, and goes with it.
  // Each note counts up, so one that repeats re-renders its text and is announced again.
  const [noted, setNoted] = useState<{ text: string; request: string | undefined; n: number }>()
  const notes = useRef(0)
  const note = noted && noted.request === request?.id ? noted.text : undefined
  const setNote = (text: string | undefined): void =>
    setNoted(text === undefined ? undefined : { text, request: request?.id, n: ++notes.current })
  // Where the shown request stands among those the agent waits on, when there are several.
  const place = request
    ? { at: conversation.requests.indexOf(request) + 1, of: conversation.requests.length }
    : undefined
  const dialog = request?.dialog ?? undefined
  const answers = dialog && taken?.dialog === dialogId(dialog) ? taken.answers : []
  const input = draft
  // The draft as it is when a turn's interrupt comes back, not as it was when asked.
  const latestDraft = useRef(draft)
  useEffect(() => {
    latestDraft.current = draft
  }, [draft])
  const setInput = onDraftChange
  const savedScroll = useRef(scrollOffset)
  const mark = tail?.mark ?? ""
  const previousOutput = useRef({ length: entries.length, cleared, mark })
  const output = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const ending = session ? terminalEnding(terminal) : null
  const commandInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!focusInput || !commandInput.current) return
    commandInput.current.focus({ preventScroll: true })
    onInputFocused()
  }, [focusInput, onInputFocused])
  // Where the output scrolls to once it's on screen, when it changed while out of sight.
  const deferred = useRef<number | "end" | null>(null)
  useEffect(() => {
    if (!output.current) return
    const changed =
      previousOutput.current.length !== entries.length ||
      previousOutput.current.cleared !== cleared ||
      previousOutput.current.mark !== mark
    const to = changed
      ? "end"
      : savedScroll.current === "end"
        ? "end"
        : (savedScroll.current ?? (entries.length || cleared || mark ? "end" : 0))
    previousOutput.current = { length: entries.length, cleared, mark }
    // Kept out of sight, the output has no box to scroll yet.
    if (!output.current.clientHeight) deferred.current = to
    output.current.scrollTop = to === "end" ? output.current.scrollHeight : to
  }, [entries.length, cleared, mark])
  useEffect(() => {
    const element = output.current
    if (!element) return
    const shows = new ResizeObserver(() => {
      if (deferred.current === null || !element.clientHeight) return
      element.scrollTop = deferred.current === "end" ? element.scrollHeight : deferred.current
      deferred.current = null
    })
    shows.observe(element)
    return () => shows.disconnect()
  }, [])
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
  // Sends the line to the agent, or answers the request that waits. A line it can't take
  // stays in the draft.
  const submit = (line: string): void => {
    if (!link || !live) return
    const fail = (error: unknown): void =>
      setNote(error instanceof Error ? error.message : "That didn't go through.")
    setNote(undefined)
    const { conversations } = link.agent
    // What the screen can't answer stands aside for a prompt, which moves the agent on.
    if (!request || dialog?.type === "form" || dialog?.type === "raw") {
      setInput("")
      conversations.send(link.key, line.trim()).catch(fail)
      return
    }
    if (!dialog) return setNote("This request isn't ready to answer yet.")
    if (request.answered) return setNote("Already answered; the agent is catching up.")
    const result = readLine(line, dialog, answers)
    if (result.type === "note") return setNote(result.text)
    setInput("")
    if (result.type === "next")
      return setTaken({ dialog: dialogId(dialog), answers: result.answers })
    setTaken(undefined)
    conversations.answer(link.key, request.id, result.answer).catch(fail)
  }
  const scroller = (
    <div
      ref={output}
      {...(session ? {} : root)}
      className={`terminal-content demo-output min-h-0 flex-1 overflow-auto [&_strong]:font-semibold${session ? "" : " nodrag nopan"}${ending ? " mb-7" : ""}`}
      onScroll={(event) => {
        const { scrollTop, scrollHeight, clientHeight } = event.currentTarget
        // A narrower layout can clamp the offset on its way out, so what is kept is that
        // it sat at the bottom, not how far down that was. Within two pixels counts, as a
        // zoomed page rounds its heights but not its offset.
        savedScroll.current = scrollHeight - clientHeight - scrollTop <= 2 ? "end" : scrollTop
        onScrollChange(savedScroll.current)
      }}
    >
      {!cleared &&
        (intro ?? (
          <TerminalOutput terminal={terminal} projectName={projectName} planned={opening.planned} />
        ))}
      {entries.map((entry) => (
        <div className="output-gap" key={entry.id}>
          <p>
            <span className="prompt-arrow mr-2 font-semibold">❯</span> {entry.command}
          </p>
          <p className="whitespace-pre-wrap muted">{entry.reply}</p>
        </div>
      ))}
      {live && tail && (
        <AgentScreen
          agent={live}
          tail={tail}
          progress={answers.length}
          place={place}
          note={note}
          noteKey={noted?.n ?? 0}
        />
      )}
      <form
        className={`command-form p-3${agent ? " agent-command-form max-w-180" : ""}`}
        onSubmit={(event) => {
          event.preventDefault()
          if (session?.locked) return
          if (ending) return session?.restart()
          if (live && input.trim()) return submit(input)
          if (input.trim()) {
            onCommand(input)
            setInput("")
          }
        }}
      >
        {!agent && (
          <div className="command-location mb-1 flex items-center gap-2 text-caption leading-[inherit] [&>svg]:ml-1">
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
            aria-label={`Command for ${terminalLabel(terminal.name, terminal.handle)}`}
            autoComplete="off"
            spellCheck={false}
            value={input}
            aria-disabled={session?.locked || undefined}
            onChange={(event) => {
              if (!session?.locked) setInput(event.target.value)
            }}
            onKeyDown={(event) => {
              // Escape stops a turn, as in the agent's TUI; the words it gives back return.
              if (event.key !== "Escape" || !link || !status?.working) return
              link.agent.conversations
                .interrupt(link.key)
                .then((words) => words && setInput(withWords(latestDraft.current, words)))
                .catch((error: unknown) =>
                  setNote(error instanceof Error ? error.message : "That didn't go through."),
                )
            }}
            placeholder={agent ? `Message ${chatAgents[agent]}…` : ""}
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
const idle = (): Conversation => noConversation
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
    const agent = useContext(DemoAgentContext)
    const link = useMemo(
      () => agent && { agent, key: { projectId, workspaceSessionId, terminalId } },
      [agent, projectId, workspaceSessionId, terminalId],
    )
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
        {...(link && { link })}
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
