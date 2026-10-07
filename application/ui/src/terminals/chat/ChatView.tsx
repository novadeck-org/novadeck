import { ArrowDown, Loader } from "lucide-react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import type { Conversation } from "../../model/conversation"
import { agentName, groupItems, turnStatus } from "../../model/conversation-turns"
import type { Store } from "../../model/store"
import type { AgentStatus } from "../../model/types"
import { Composer } from "./Composer"
import { Requests } from "./Requests"
import { Transcript } from "./Transcript"

// How many blocks of a long conversation show, and how many more "Show earlier" adds.
const windowSize = 60

// Within this many pixels of the end, the transcript follows what arrives.
const bottomSlack = 32

// The agent's conversation, drawn as a chat over its terminal: the transcript, what waits
// on the person, the agent's state, and a box that types into the agent. It fills the
// element that holds it.
export const ChatView = ({
  conversation,
  terminalName,
  program,
  agent,
  compact,
  draft,
  onDraft,
  onSend,
  onInterrupt,
  onAnswerInTerminal,
  focusInput,
  onInputFocused,
}: {
  readonly conversation: Store<Conversation>
  readonly terminalName: string
  // The terminal's foreground program, which names the agent until its session does.
  readonly program: string
  // What the terminal's agent says it is doing.
  readonly agent: AgentStatus | undefined
  readonly compact: boolean
  readonly draft: string
  readonly onDraft: (draft: string) => void
  readonly onSend: (text: string) => Promise<void>
  readonly onInterrupt: () => Promise<void>
  readonly onAnswerInTerminal: () => void
  readonly focusInput: boolean
  readonly onInputFocused: () => void
}): React.JSX.Element => {
  const {
    agent: harness,
    session,
    loaded,
    items,
    requests,
  } = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot)
  const name = agentName(harness ?? program)
  const blocks = useMemo(() => groupItems(items), [items])
  const status = turnStatus(agent)
  const working = status?.working === true

  // The latest blocks, and how many earlier ones the person asked for.
  const [more, setMore] = useState<{ readonly session: string | null; readonly extra: number }>({
    session,
    extra: 0,
  })
  const extra = more.session === session ? more.extra : 0
  const shownFrom = Math.max(0, blocks.length - windowSize - extra)
  const shown = shownFrom === 0 ? blocks : blocks.slice(shownFrom)

  const scroller = useRef<HTMLDivElement>(null)
  const thread = useRef<HTMLDivElement>(null)
  // Following the end: true while the person is at it, so new text keeps in view and
  // scrolling up lets go.
  const following = useRef(true)
  const [atEnd, setAtEnd] = useState(true)
  const prepended = useRef<number | null>(null)
  const follow = useCallback((): void => {
    const element = scroller.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [])
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && prepended.current !== null) {
      // Earlier blocks went in above: stay on what was in view.
      element.scrollTop += element.scrollHeight - prepended.current
      prepended.current = null
      return
    }
    follow()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Follows whenever the blocks change.
  }, [shown, follow])
  // Code highlighting, images and folded rows change the height after the fact.
  useEffect(() => {
    const content = thread.current
    if (!content || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(follow)
    observer.observe(content)
    return () => observer.disconnect()
  }, [follow])

  const empty = items.length === 0
  return (
    <section
      className="chat"
      data-compact={compact || undefined}
      aria-label={`${terminalName} chat`}
    >
      <div className="chat-main">
        <div
          ref={scroller}
          className="chat-scroll nodrag nopan nowheel"
          role="log"
          tabIndex={0}
          aria-label={`Conversation with ${name}`}
          aria-busy={!loaded && session !== null}
          onScroll={(event) => {
            const { scrollTop, scrollHeight, clientHeight } = event.currentTarget
            const near = scrollHeight - scrollTop - clientHeight <= bottomSlack
            following.current = near
            setAtEnd(near)
          }}
        >
          <div ref={thread} className="chat-thread">
            {shownFrom > 0 && (
              <button
                type="button"
                className="button quiet chat-earlier"
                onClick={() => {
                  prepended.current = scroller.current?.scrollHeight ?? null
                  setMore({ session, extra: extra + windowSize })
                }}
              >
                Show earlier messages ({shownFrom})
              </button>
            )}
            {empty && (
              <p className="chat-empty" role="status">
                {session === null
                  ? `No conversation yet. It shows here once ${name} starts its session.`
                  : !loaded
                    ? "Loading the conversation…"
                    : "Nothing said yet. Send a prompt below."}
              </p>
            )}
            <Transcript blocks={shown} agent={name} working={working} />
            {status && (
              <p
                className="chat-status"
                role="status"
                data-working={working || undefined}
                data-ended={!working || undefined}
              >
                {working && <Loader size={12} aria-hidden className="chat-spinner" />}
                {status.text}
              </p>
            )}
          </div>
        </div>
        {!atEnd && (
          <button
            type="button"
            className="chat-jump nodrag nopan"
            aria-label="Jump to latest"
            onClick={() => {
              const element = scroller.current
              if (!element) return
              following.current = true
              element.scrollTop = element.scrollHeight
              setAtEnd(true)
            }}
          >
            <ArrowDown size={14} aria-hidden />
            <span>Latest</span>
          </button>
        )}
      </div>
      <Requests requests={requests} onAnswer={onAnswerInTerminal} />
      <Composer
        label={name}
        draft={draft}
        onDraft={onDraft}
        working={working}
        onSend={onSend}
        onStop={onInterrupt}
        focusInput={focusInput}
        onInputFocused={onInputFocused}
      />
    </section>
  )
}
