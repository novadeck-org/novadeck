import { WordsLost, type ChatAnswer, type Conversation } from "@novadeck/core/conversation"
import { wordsOf } from "@novadeck/core/conversation/picks"
import { shellCommand, type Refused } from "@novadeck/core/conversation/prompt-refusal"
import {
  agentName,
  groupItems,
  recordsShell,
  turnStatus,
  wentItems,
} from "@novadeck/core/conversation/turns"
import { isAgentName, opensMenu } from "@novadeck/core/harnesses"
import type { Store } from "@novadeck/core/store"
import type { AgentStatus } from "@novadeck/core/types"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import type { Attachment } from "./attachments"
import { sentBubbles, type SentBubble } from "./bubbles"
import { Composer } from "./Composer"
import { composerMode } from "./composer-mode"
import { joinDraft } from "./drafts"
import { useEchoes } from "./echoes"
import { promptsOf, type SentShell } from "./history"
import { Mark } from "./Mark"
import { otherMenu } from "./other-menu"
import { usePassing } from "./passing"
import { sameReply, type ChatReply, type ChatReplyTo } from "./replies"
import { Requests } from "./Requests"
import { takeSentImages, type ChatSend } from "./sends"
import { settledSent, settleSent } from "./settled"
import { LiveSlice, Slice, SliceKeys } from "./Slice"
import { Transcript, type PeerLooks } from "./Transcript"

const noShells: readonly SentShell[] = []

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
  peerLooks,
  draft,
  onDraft,
  replyTo,
  onReplyTo,
  sending,
  attachments,
  imageNote,
  onRestore,
  onAttach,
  onDetach,
  onSend,
  shells = noShells,
  onInterrupt,
  onClearBox,
  onAnswer,
  onAnswerInTerminal,
  onWordsLost,
  focusInput,
  onInputFocused,
  refused,
  onKeys,
  onPassing,
  onLeftMenu,
}: {
  readonly conversation: Store<Conversation>
  readonly terminalName: string
  // The terminal's foreground program, which names the agent until its session does.
  readonly program: string
  // What the terminal's agent says it is doing.
  readonly agent: AgentStatus | undefined
  readonly compact: boolean
  // How other Novadeck agents look in the transcript (their face and where they run), where the
  // app knows them; without it their messages have neither.
  readonly peerLooks?: PeerLooks | undefined
  readonly draft: string
  readonly onDraft: (draft: string) => void
  // The question the draft replies to, or that it is held, kept with the draft by the app.
  readonly replyTo: ChatReplyTo | null
  readonly onReplyTo: (to: ChatReplyTo | null) => void
  // The words from the box on their way to the agent, oldest first, which the app keeps.
  readonly sending: readonly ChatSend[]
  // The images pasted into the box, to go with its next message, which the app keeps with the draft.
  readonly attachments: readonly Attachment[]
  readonly imageNote?: string | undefined
  // Puts a line with images taken back to edit in the box, ahead of what it holds: its words with
  // their placeholders, and the images.
  readonly onRestore: (words: string, images: readonly Attachment[]) => void
  // Adds pasted images, saving each at once and typing their placeholders into the draft over the
  // selection; answers where the caret goes and why some weren't added, or null. Absent where the
  // backend takes no images.
  readonly onAttach?:
    | ((
        files: readonly File[],
        selection: { readonly start: number; readonly end: number },
      ) => { readonly refusal: string | null; readonly caret: number | null })
    | undefined
  readonly onDetach: (id: string) => void
  // Sends the box's words, as a prompt or as the reply `to` names: the app takes them
  // out of the draft as they go, queues a prompt behind those still on their way, and puts
  // them back should they not arrive. It resolves whether they went: false once they came
  // back to the box unsent.
  readonly onSend: (
    text: string,
    to: ChatReply | null,
    images?: readonly Attachment[],
  ) => Promise<boolean>
  // The shell commands sent from this chat, which its history recalls.
  readonly shells?: readonly SentShell[] | undefined
  readonly onInterrupt: () => Promise<void>
  // Empties the agent's own input box of the text the chat showed it holds.
  readonly onClearBox: (seen: string) => Promise<void>
  readonly onAnswer: (request: string, answer: ChatAnswer) => Promise<void>
  readonly onAnswerInTerminal: () => void
  // Words that were to follow an answer and didn't reach the agent, for the person's box.
  readonly onWordsLost: (words: string) => void
  readonly focusInput: boolean
  readonly onInputFocused: () => void
  // Whether text would be refused as a message for its shape, as the backend says.
  readonly refused: Refused
  // Writes keys to the agent's terminal, for what shows of its own; absent where it takes none.
  readonly onKeys?: ((keys: string) => Promise<void>) | undefined
  // Tells whether keys pass to the terminal's box; and the draft goes as the chat leaves with
  // a menu up, whatever session shows by then.
  readonly onPassing?: ((on: boolean) => void) | undefined
  readonly onLeftMenu?: (() => void) | undefined
}): React.JSX.Element => {
  const {
    agent: harness,
    session,
    loaded,
    items,
    requests,
    prompts,
    slice,
    box,
    doorbell,
  } = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot)
  const name = agentName(harness ?? program)
  const blocks = useMemo(
    () => groupItems(wentItems(items, prompts), doorbell.delivered),
    [items, prompts, doorbell.delivered],
  )
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

  // What the person dealt with on the page, a notice dismissed or a prompt sent again, draws the
  // chat again.
  const [, setSettlements] = useState(0)
  const settled = settledSent()
  // The person's prompts the agent's record doesn't show yet.
  const bubbles = useMemo(
    () => sentBubbles(sending, prompts, items.length).filter(({ ref }) => !settled.has(ref)),
    [sending, prompts, items.length, settled],
  )
  // The requests whose cards show: a question that a message on its way sets aside goes as
  // the message goes, and comes back only should it not go.
  const asked = useMemo(() => {
    const aside = new Set(
      sending.flatMap((send) =>
        send.phase === "typing" || send.phase === "sent" ? (send.setAside ?? []) : [],
      ),
    )
    return aside.size > 0 ? requests.filter((request) => !aside.has(request.id)) : requests
  }, [requests, sending])

  // The agent whose menus the box calls up, as passing names it.
  const menuAgent = harness ?? program
  // What Up in the box recalls: the person's prompts to this agent.
  const history = useMemo(
    () =>
      promptsOf(wentItems(items, prompts), bubbles, shells, menuAgent, (text) =>
        isAgentName(menuAgent) ? opensMenu(text, menuAgent) : false,
      ),
    [items, prompts, bubbles, shells, menuAgent],
  )

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
  }, [shown, bubbles, follow])
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
  // Why a prompt sent again from its line didn't go, its words back in the box.
  const [resent, setResent] = useState<string | null>(null)
  // A shell command went to an agent that keeps no record of it in its conversation, as its
  // harness says: its output shows only in the terminal.
  const [unrecorded, setUnrecorded] = useState(false)
  const answer = useCallback(
    (request: string, reply: ChatAnswer): Promise<void> =>
      onAnswer(request, reply).catch((failure: unknown) => {
        if (failure instanceof WordsLost) {
          const words = wordsOf(reply)
          if (words) onWordsLost(words)
          setLost(words !== "")
        }
        throw failure
      }),
    [onAnswer, onWordsLost],
  )

  // What the box does with its words. Its agent's requests are known once its agent is.
  const mode = composerMode(draft, replyTo, requests, harness !== null)
  const reply = mode === "reply" && replyTo !== null && replyTo !== "held" ? replyTo : null
  // A reply ends with its dialog, for good: the same dialog read again doesn't bring it
  // back. Words still in the box are held, as a reply whose question went, until the
  // person edits them, whether the chat was on screen as it went or comes back after.
  // Never while the reply itself is on its way, whose arrival ends it.
  const lapsed = replyTo !== null && replyTo !== "held" && mode !== "reply" && mode !== "waiting"
  const replyGoing =
    replyTo !== null &&
    replyTo !== "held" &&
    sending.some((send) => send.to !== null && sameReply(send.to, replyTo))
  useLayoutEffect(() => {
    if (lapsed && !replyGoing) onReplyTo(draft.trim() !== "" ? "held" : null)
  }, [lapsed, replyGoing, draft, onReplyTo])
  const focusBox = (): void =>
    scroller.current
      ?.closest(".chat")
      ?.querySelector<HTMLElement>(".chat-input")
      ?.focus({ preventScroll: true })

  const echoes = useEchoes(slice, items)
  const passing = usePassing({
    // Its program until a session binds, as Codex and Antigravity do only at a first prompt.
    agent: harness ?? program,
    open: mode === "message",
    draft,
    onDraft,
    box,
    slice,
    write: onKeys,
    onKept: echoes.drop,
    ...(onPassing && { onPassing }),
    ...(onLeftMenu && { onLeft: onLeftMenu }),
  })
  // The person's draft as it changes, from the box or from a prompt taken back to edit.
  const draftEdited = (): void => {
    setLost(false)
    setResent(null)
    setUnrecorded(false)
    // Words held as a reply whose question went are the person's message once edited,
    // as the hold is written or not yet; not while that reply is on its way, whose
    // words, should it fail, come back held.
    if (mode === "held" && replyTo !== "held" && !replyGoing) onReplyTo(null)
  }
  const draftChanged = (text: string): void => {
    draftEdited()
    passing.edit(text)
  }
  // A prompt the record never got, dealt with: sent again, whose words come back to the box should
  // they not go, or back in the box, ahead of what's written there.
  const settle = (bubble: SentBubble): void => {
    settleSent(bubble.ref)
    setSettlements((count) => count + 1)
  }
  // Only a plain message takes either: a reply, a held reply, a shell command or a harness's menu
  // in the box would turn the words into something else.
  const plain = mode === "message" && !passing.on
  const resend = (bubble: SentBubble): void => {
    settle(bubble)
    setResent(null)
    focusBox()
    // Its own images go, never those the box holds.
    onSend(bubble.text, null, takeSentImages(bubble.ref)).then(
      (went) => {
        if (!went) setResent("Your words didn't go again. They're in the box below.")
      },
      (failure: unknown) =>
        setResent(
          failure instanceof Error && failure.message
            ? `${failure.message} Your words are in the box below.`
            : "Your words didn't go again. They're in the box below.",
        ),
    )
  }
  const edit = (bubble: SentBubble): void => {
    settle(bubble)
    const images = takeSentImages(bubble.ref)
    if (images.length > 0) {
      // The words and their images come back together, the placeholders renumbered to the box's.
      draftEdited()
      onRestore(bubble.text, images)
    } else draftChanged(joinDraft(bubble.text, draft))
    focusBox()
  }

  const sliceKeys = useMemo(
    () => onKeys && ((keys: string) => void onKeys(keys).catch(() => {})),
    [onKeys],
  )
  // What took the keys went: they come back to the box.
  const taken = slice !== null && slice.reason !== "menu"
  const wasTaken = useRef(false)
  useEffect(() => {
    const active = document.activeElement
    if (wasTaken.current && !taken && (!active || active === document.body)) focusBox()
    wasTaken.current = taken
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Only as it comes and goes.
  }, [taken])

  const empty = items.length === 0 && bubbles.length === 0 && echoes.shown.length === 0
  return (
    <SliceKeys.Provider value={sliceKeys ?? null}>
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
              <Transcript
                blocks={shown}
                agent={name}
                working={working}
                gone={agent === undefined}
                sent={bubbles}
                looks={peerLooks}
                {...(plain &&
                  draft.trim() === "" &&
                  attachments.length === 0 && { onResend: resend })}
                {...(plain && { onEdit: edit })}
                onShowTerminal={onAnswerInTerminal}
              />
              {echoes.shown.map((echo) => (
                <div key={echo.id} className="chat-echo">
                  <Mark />
                  <p className="chat-echo-text">{echo.text}</p>
                  {echo.slice && <Slice slice={echo.slice} />}
                </div>
              ))}
              {status && (
                <p
                  className="chat-status"
                  role="status"
                  data-working={working || undefined}
                  data-ended={!working || undefined}
                >
                  {working && <span className="chat-spin" aria-hidden />}
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
              latest ↓
            </button>
          )}
        </div>
        {slice && slice.reason !== "dialog" && (
          <LiveSlice
            slice={slice}
            agent={name}
            aside={slice.reason === "menu" ? otherMenu(harness ?? program, draft) : null}
          />
        )}
        <Requests
          requests={asked}
          slice={slice}
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
          replySending={reply !== null && replyGoing}
          onReply={(request, dialog) => {
            // A new reply takes the words in the box as its own.
            onReplyTo(dialog === null ? null : { request, dialog })
            if (dialog !== null) focusBox()
          }}
          // The dialog went to talk it over: the person's words go in the box, as a prompt.
          onChatting={focusBox}
          refused={refused}
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
                className="chat-key nodrag nopan"
                aria-label="Show terminal"
                onClick={onAnswerInTerminal}
              >
                terminal
              </button>
            </p>
          )}
        </div>
        {resent && (
          <p className="chat-lost" role="alert">
            {resent}
          </p>
        )}
        {lost && (
          <p className="chat-lost" role="alert">
            Your words didn't reach the agent. They're in the box below. The agent's own input box
            may still hold them too.
          </p>
        )}
        <Composer
          label={name}
          box={box}
          draft={draft}
          onDraft={draftChanged}
          mode={mode}
          sending={sending.some((send) => send.to !== null)}
          replySending={replyGoing}
          working={working}
          attachments={attachments}
          imageNote={imageNote}
          // Antigravity refuses a message of images alone, so an agent not known yet might.
          imagesAlone={harness === "claude" || harness === "codex"}
          onAttach={onAttach}
          onDetach={onDetach}
          onSend={async (text) => {
            if (mode === "waiting")
              throw new Error("The conversation is still loading. Send again in a moment.")
            // The words in the box went: the note that they're there goes with them.
            setLost(false)
            const went = await onSend(text, reply)
            // Only a command that went ran: one handed back unsent, by a Stop or a prompt before
            // it that didn't go, sits in the box again.
            if (went && !reply)
              setUnrecorded(!recordsShell(harness) && shellCommand(text) !== undefined)
          }}
          onStop={async () => {
            await passing.leave()
            await onInterrupt()
          }}
          onClearBox={onClearBox}
          focusInput={focusInput}
          onInputFocused={onInputFocused}
          onCancelReply={() => {
            onReplyTo(null)
            focusBox()
          }}
          onOpenTerminal={onAnswerInTerminal}
          refused={(text, options) => !passing.on && refused(text, options)}
          passing={passing.on}
          history={history}
          onPress={(keys) => {
            const went = passing.press(keys)
            if (went && keys === "\r" && draft.startsWith("/")) echoes.echo(draft.trim())
            return went
          }}
        />
      </section>
    </SliceKeys.Provider>
  )
}
