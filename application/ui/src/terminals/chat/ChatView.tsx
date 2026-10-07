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

import { WordsLost, type ChatAnswer, type Conversation } from "../../model/conversation"
import { agentName, groupItems, turnStatus } from "../../model/conversation-turns"
import { shellCommand } from "../../model/prompt-refusal"
import type { Store } from "../../model/store"
import type { AgentStatus } from "../../model/types"
import { chatAnswer, oneLine, wordsOf } from "./answers"
import { Composer } from "./Composer"
import type { ChatReplyTo } from "./mode-state"
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
  replyTo,
  onReplyTo,
  onDraftSent,
  onSend,
  onInterrupt,
  onAnswer,
  onAnswerInTerminal,
  onWordsLost,
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
  // The question the draft replies to, or that it is held, kept with the draft by the owner.
  readonly replyTo: ChatReplyTo | null
  readonly onReplyTo: (to: ChatReplyTo | null) => void
  // The draft went to the agent: the owner clears it, if it still holds those words.
  readonly onDraftSent: (text: string) => void
  readonly onSend: (text: string) => Promise<void>
  readonly onInterrupt: () => Promise<void>
  readonly onAnswer: (request: string, answer: ChatAnswer) => Promise<void>
  readonly onAnswerInTerminal: () => void
  // Words that were to follow an answer and didn't reach the agent, for the person's box.
  readonly onWordsLost: (words: string) => void
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

  // The person's words that were to follow an answer and didn't reach the agent, handed
  // back to the draft whether or not the card they were typed in is still on screen.
  const [lost, setLost] = useState(false)
  // A shell command went to an agent that keeps no record of it in its conversation
  // (Antigravity): its output shows only in the terminal.
  const [unrecorded, setUnrecorded] = useState(false)
  const alive = useRef(true)
  // Counts the times words were handed back, so a send that began before one can't clear it.
  const handedBack = useRef(0)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const answer = useCallback(
    (request: string, reply: ChatAnswer): Promise<void> =>
      onAnswer(request, reply).catch((failure: unknown) => {
        if (failure instanceof WordsLost) {
          const words = wordsOf(reply)
          handedBack.current += 1
          if (words) onWordsLost(words)
          if (alive.current) setLost(words !== "")
        }
        throw failure
      }),
    [onAnswer, onWordsLost],
  )

  // The question the box answers, while the person replies to it there: one whose dialog
  // takes the words in the agent's own field. It ends with the dialog.
  const replying = replyTo !== null && replyTo !== "held" ? replyTo : null
  const [replySending, setReplySending] = useState(false)
  const reply = requests.some(
    (request) =>
      request.id === replying?.request &&
      !request.answered &&
      request.dialog?.type === "questions" &&
      request.dialog.id === replying.dialog &&
      request.dialog.chat === "field",
  )
    ? replying
    : null
  // The mode ends with the dialog, for good: the same dialog read again doesn't bring it
  // back. Words still in the box are held, as a reply whose question went, until the
  // person edits them, whether the chat was on screen as it went or comes back after.
  // Only once the conversation is read: a chat back on screen starts empty until its agent's
  // requests come, which arrive with its agent.
  const lapsed = replying !== null && reply === null && !replySending && harness !== null
  const held = (replyTo === "held" || lapsed) && draft.trim() !== ""
  // A reply whose conversation isn't read yet stays one, and waits for it.
  const unread = replying !== null && harness === null
  useLayoutEffect(() => {
    if (lapsed) onReplyTo(draft.trim() !== "" ? "held" : null)
    else if (replyTo === "held" && draft.trim() === "") onReplyTo(null)
  }, [lapsed, replyTo, draft, onReplyTo])
  const focusBox = (): void =>
    scroller.current
      ?.closest(".chat")
      ?.querySelector<HTMLElement>(".chat-input")
      ?.focus({ preventScroll: true })

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
      <Requests
        requests={requests}
        agent={name}
        onAnswer={answer}
        onAnswerInTerminal={onAnswerInTerminal}
        onSettled={() => {
          // The card that was answered went: the box takes focus, unless the person moved it.
          const active = document.activeElement
          if (active && active !== document.body) return
          focusBox()
        }}
        replying={reply?.request ?? null}
        replySending={replySending}
        onReply={(request, dialog) => {
          // A new reply takes the words in the box as its own.
          onReplyTo(dialog === null ? null : { request, dialog })
          if (dialog !== null) focusBox()
        }}
        // The dialog went to talk it over: the person's words go in the box, as a prompt.
        onChatting={focusBox}
      />
      {/* Always in the page, so a screen reader announces the note as it appears. */}
      <div role="status">
        {unrecorded && (
          <p className="chat-lost chat-unrecorded">
            <span>
              {name} ran it in its terminal. It keeps no record of shell commands here, so the
              output shows only there.
            </span>
            <button
              type="button"
              className="button quiet nodrag nopan"
              onClick={onAnswerInTerminal}
            >
              Show terminal
            </button>
          </p>
        )}
      </div>
      {lost && (
        <p className="chat-lost" role="alert">
          Your words didn't reach the agent. They're in the box below. The agent's own input box may
          still hold them too.
        </p>
      )}
      <Composer
        label={name}
        draft={draft}
        onDraft={(text) => {
          setLost(false)
          setUnrecorded(false)
          if (replyTo === "held") onReplyTo(null)
          onDraft(text)
        }}
        working={working}
        onSend={async (text) => {
          if (unread) throw new Error("The conversation is still loading. Send again in a moment.")
          if (reply) {
            // The words answer the question, in the agent's field, which takes one line.
            setReplySending(true)
            try {
              await onAnswer(reply.request, chatAnswer(reply.dialog, oneLine(text)))
            } finally {
              if (alive.current) setReplySending(false)
            }
            onDraftSent(text)
            onReplyTo(null)
            if (alive.current) setLost(false)
            return
          }
          const before = handedBack.current
          await onSend(text)
          if (alive.current) setUnrecorded(harness === "agy" && shellCommand(text) !== undefined)
          // Sent: the words handed back are gone from the box, unless more came meanwhile.
          if (alive.current && handedBack.current === before) setLost(false)
        }}
        onStop={onInterrupt}
        focusInput={focusInput}
        onInputFocused={onInputFocused}
        replying={reply !== null || unread}
        orphaned={reply === null && held}
        onCancelReply={() => {
          onReplyTo(null)
          focusBox()
        }}
      />
    </section>
  )
}
