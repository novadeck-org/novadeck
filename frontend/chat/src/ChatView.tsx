import {
  WordsLost,
  type ChatAnswer,
  type ChatImage,
  type Conversation,
} from "@novadeck/core/conversation"
import { emptiness } from "@novadeck/core/conversation/emptiness"
import { wordsOf } from "@novadeck/core/conversation/picks"
import { shellCommand, type Refused } from "@novadeck/core/conversation/prompt-refusal"
import {
  agentName,
  groupItems,
  recordsShell,
  turnStartedAt,
  turnStatus,
  wentItems,
} from "@novadeck/core/conversation/turns"
import { isAgentName, opensMenu } from "@novadeck/core/harnesses"
import type { Store } from "@novadeck/core/store"
import type { AgentStatus } from "@novadeck/core/types"
import { useMounted } from "@novadeck/requests/use-mounted"
import type { Mention } from "@novadeck/toolkit/mentions"
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import type { Attachment } from "./attachments"
import { blockAt, sentBubbles, type SentBubble } from "./bubbles"
import { Composer, failed, type Failure } from "./Composer"
import { composerMode } from "./composer-mode"
import { joinDraft } from "./drafts"
import { useEchoes } from "./echoes"
import { Fact, Since } from "./Fact"
import { Holding, useHeldSnapshot, useHolds } from "./held"
import { promptsOf, type SentShell } from "./history"
import { Hold } from "./Hold"
import { markPhase, type WindowPhase } from "./mark-phase"
import { otherMenu } from "./other-menu"
import { usePassing, type PassingState } from "./passing"
import { sameReply, type ChatReply, type ChatReplyTo } from "./replies"
import { Requests, type RequestsHandle } from "./Requests"
import { recordedImagesOf, takeSentImages, type ChatSend } from "./sends"
import { settledSent, settleSent } from "./settled"
import { ShellLines, listedShells, type ShellTailsSource } from "./ShellLines"
import { LiveSlice, SliceKeys } from "./Slice"
import { ThumbsContext, useThumbs } from "./Thumbs"
import { mentionOf, Transcript, type PeerLooks } from "./Transcript"
import { currentPrompt, logPadding, scrollFor, startBefore, startRows } from "./turn-holds"
import { Unproven } from "./Unproven"
import { useBoxReturn } from "./use-box-return"
import { useTranscriptMotion } from "./use-transcript-motion"
import { useTurnHold } from "./use-turn-hold"

const noShells: readonly SentShell[] = []

// Where the log stood as blocks went in above (see `prepended`).
type Standing = {
  readonly row: HTMLElement | null
  readonly at: number
  readonly height: number
  readonly top: number
  readonly until: number | null
}

// How many blocks of a long conversation show, and how many more "Show earlier" adds.
const windowSize = 60
// How many of them a chat draws as it shows, and adds at a time once the page is idle: a switch
// that shows many chats at once builds only what is in view first. More go in before the first
// paint while the log isn't full, so what shows never moves down as the rest arrive.
const firstSize = 10
const growBy = 10

// Runs `grow` once the page is idle, or at the next turn where the browser can't say.
const whenIdle = (grow: () => void): (() => void) => {
  if (typeof requestIdleCallback === "function") {
    const idle = requestIdleCallback(grow, { timeout: 1000 })
    return () => cancelIdleCallback(idle)
  }
  const timer = setTimeout(grow, 0)
  return () => clearTimeout(timer)
}

// Within this many pixels of the end, the transcript follows what arrives.
const bottomSlack = 32

// The agent's conversation, drawn as a chat over its terminal: the transcript, what waits
// on the person, the agent's state, and a box that types into the agent. It fills the
// element that holds it. Out of sight (see ./held), it draws nothing as its agent works.
const ChatBody = ({
  conversation,
  terminalName,
  program,
  agent,
  compact,
  windowPhase,
  peerLooks,
  peerMention,
  personFace,
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
  onImage,
  onSend,
  shells = noShells,
  shellTails,
  onOpenShell,
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
  // The window's phase line as the app works it out, which the mark of the current turn's prompt
  // wears; without it the mark stands still.
  readonly windowPhase?: WindowPhase | undefined
  // How other Novadeck agents look in the transcript (their face and where they run), where the
  // app knows them; without it their messages have neither.
  readonly peerLooks?: PeerLooks | undefined
  // Which handles in the words name an agent, and its hue. Its identity changes only with that
  // set, so words aren't drawn again as agents start or stop work; without it, taken from the looks.
  readonly peerMention?: Mention | undefined
  // The person's own face at their words that came through the Inbox rather than the prompt,
  // where the app gives one; without it they keep the block mark.
  readonly personFace?: React.ReactNode
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
  // The picture of a prompt image the record lists, as a data URL, null where it can't be shown;
  // absent where the backend can't find one again.
  readonly onImage?: ((image: ChatImage) => Promise<string | null>) | undefined
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
  // Where the last line of each of the agent's background shells' output comes from, which
  // shows under its line (the lines subscribe to it); and what opens a shell's output, which makes its line a button.
  // Both come from the app where it can show the output; without them the lines stand alone.
  readonly shellTails?: ShellTailsSource | undefined
  readonly onOpenShell?: ((shellId: string) => void) | undefined
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
  // Tells whether keys pass to the terminal's box, or may still show there; and the draft goes as
  // the chat leaves with a menu up, whatever session shows by then.
  readonly onPassing?: ((state: PassingState) => void) | undefined
  readonly onLeftMenu?: (() => void) | undefined
}): React.JSX.Element => {
  const {
    agent: harness,
    session,
    loaded,
    records,
    rest,
    turned,
    screen,
    items,
    requests,
    prompts,
    slice,
    box,
    doorbell,
  } = useHeldSnapshot(conversation.subscribe, conversation.getSnapshot)
  const name = agentName(harness ?? program)
  const blocks = useMemo(
    () => groupItems(wentItems(items, prompts), doorbell.delivered),
    [items, prompts, doorbell.delivered],
  )
  // The pictures the thumbnails of recorded prompts show: this window's own previews of what it
  // sent, where it still has them, else what the backend finds in the record.
  const previews = useCallback(
    (item: string) => {
      const prompt = prompts.find(
        ({ state, item: at }) => state === "settled" && at !== null && `${session}:${at}` === item,
      )
      return prompt && recordedImagesOf(prompt.ref)
    },
    [prompts, session],
  )
  const thumbs = useThumbs(onImage, previews)
  const status = turnStatus(agent)
  const working = status?.working === true
  // The background shells still running or failed, which stand under the working line.
  const listed = listedShells(agent?.shells)
  const [shellsOpen, setShellsOpen] = useState(false)
  // When the turn began, for the working line's clock.
  const turnStart = useMemo(() => turnStartedAt(blocks), [blocks])

  // The latest blocks, and how many earlier ones the person asked for.
  const [more, setMore] = useState<{ readonly session: string | null; readonly extra: number }>({
    session,
    extra: 0,
  })
  const extra = more.session === session ? more.extra : 0
  // How much of the window is drawn so far (see `firstSize`), for this session: another one
  // draws its own in steps too.
  const [grown, setGrown] = useState<{ readonly session: string | null; readonly count: number }>({
    session,
    count: firstSize,
  })
  const admitted = grown.session === session ? grown.count : firstSize
  const admit = useCallback(
    (count: (now: number) => number): void =>
      setGrown((before) => ({
        session,
        count: count(before.session === session ? before.count : firstSize),
      })),
    [session],
  )
  const shownFrom = Math.max(0, blocks.length - Math.min(admitted, windowSize) - extra)
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

  const fromLooks = useMemo(() => mentionOf(peerLooks), [peerLooks])
  const mention = peerMention ?? fromLooks
  // Every turn's start, those whose rows aren't shown yet too: the earlier turn whose end the log
  // begins with still holds the top.
  const turns = useTurnHold(blocks, compact)
  const carried = useMemo(() => startBefore(blocks, shownFrom), [blocks, shownFrom])
  const { peek, setPeek } = turns
  const scroller = useRef<HTMLDivElement>(null)
  const chatSection = useRef<HTMLElement>(null)
  const heldId = turns.held?.id ?? null
  const peeking = peek !== null && peek === heldId
  const thread = useRef<HTMLDivElement>(null)
  useTranscriptMotion(thread, session, loaded)
  // Following the end: true while the person is at it, so new text keeps in view and
  // scrolling up lets go.
  const following = useRef(true)
  const [atEnd, setAtEnd] = useState(true)
  // Where the log stood as blocks go in above: the first row in view and where it stood, the
  // log's height and its scroll position; while the window grows, until it is `until` blocks.
  const prepended = useRef<Standing | null>(null)
  const standing = useCallback((until: number | null = null): Standing | null => {
    const element = scroller.current
    if (!element) return null
    const top = element.scrollTop
    const row =
      [...(thread.current?.children ?? [])].find(
        (child): child is HTMLElement =>
          child instanceof HTMLElement &&
          !child.matches(".chat-earlier") &&
          child.offsetTop + child.offsetHeight > top,
      ) ?? null
    return { row, at: row?.offsetTop ?? 0, height: element.scrollHeight, top, until }
  }, [])
  const follow = useCallback((): void => {
    const element = scroller.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [])
  // A prompt to scroll to once the earlier blocks it is among are shown.
  const pendingTurn = useRef<((element: HTMLElement) => void) | null>(null)
  useLayoutEffect(() => {
    const element = scroller.current
    const stood = prepended.current
    if (element && stood !== null && !(stood.until !== null && following.current)) {
      // Earlier blocks went in above: stay on what was in view, or go to the prompt they were
      // shown for. By the row that was in view, which blocks arriving below or leaving the top
      // move too; from where it stood, not where it is, as the browser's own scroll anchoring may
      // have moved it already.
      const moved = stood.row?.isConnected
        ? stood.row.offsetTop - stood.at
        : element.scrollHeight - stood.height
      element.scrollTop = stood.top + moved
      // A step of the window that hasn't drawn yet, behind blocks that came first: kept for it.
      if (stood.until !== null && admitted < stood.until) {
        prepended.current = standing(stood.until)
        return
      }
      prepended.current = null
      pendingTurn.current?.(element)
      pendingTurn.current = null
      return
    }
    // A log following its end follows it, whatever went in above.
    if (stood !== null && (stood.until === null || admitted >= stood.until))
      prepended.current = null
    follow()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Follows whenever the blocks change.
  }, [shown, bubbles, follow, admitted, standing])
  // Code highlighting, images and folded rows change the height after the fact. The rows that
  // start a turn move as the log does: the prompt that holds the top is measured as the observer
  // starts to watch, which is as the turns change, and at each change after.
  const { measure } = turns
  useEffect(() => {
    const content = thread.current
    if (!content || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      follow()
      measure(scroller.current)
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [follow, measure])
  // The rest of the window goes in above what shows: while the log isn't full, before it is
  // painted; after, a few blocks at a time as the page is idle, what is in view kept where it is.
  const growing = admitted < windowSize && shownFrom > 0
  useLayoutEffect(() => {
    const element = scroller.current
    if (!growing || !element || element.clientHeight === 0) return
    if (element.scrollHeight > element.clientHeight) return
    admit((count) => Math.min(windowSize, count + growBy))
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Measures again as the blocks change.
  }, [growing, shown, admit])
  useEffect(() => {
    if (!growing) return
    return whenIdle(() => {
      const until = Math.min(windowSize, admitted + growBy)
      prepended.current ??= standing(until)
      admit(() => until)
    })
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A step at a time, each after the last drew.
  }, [growing, shown, admit, admitted, standing])
  // The person's words that were to follow an answer and didn't reach the agent, handed
  // back to the draft whether or not the card they were typed in is still on screen.
  const [lost, setLost] = useState(false)
  // Why a prompt sent again from its line didn't go, its words back in the box.
  const [resent, setResent] = useState<string | null>(null)
  // A shell command went to an agent that keeps no record of it in its conversation, as its
  // harness says: its output shows only in the terminal.
  const [unrecorded, setUnrecorded] = useState(false)
  // Stop, from the working line or Esc: one at a time, and why one didn't go.
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<Failure | null>(null)
  const mounted = useMounted()
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

  // What the box does with its words. Its agent's requests are known once its agent is; a
  // question a message on its way sets aside is gone for a reply, as its card is.
  const mode = composerMode(draft, replyTo, asked, harness !== null)
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

  // Where the keyboard goes as the chat gives it out: to a card whose dialog never had it, before
  // the box, as a harness's own dialog takes the keys as it shows.
  const requestsHandle = useRef<RequestsHandle>(null)
  const claimCard = (): boolean => requestsHandle.current?.claim() ?? false
  const focusEntry = (): void => {
    if (!claimCard()) focusBox()
  }

  // Focus left on a control that went or was disabled (it falls to the page, where Esc isn't heard
  // by the chat) goes to the held line where there is one, else the box.
  const refocus = useRef(false)
  const keepFocus = (): void => {
    const chat = chatSection.current
    const active = document.activeElement
    if (
      !chat ||
      (active && active !== document.body && chat.contains(active) && !active.matches(":disabled"))
    )
      return
    const line = chat.querySelector<HTMLElement>(".chat-hold-line")
    if (line) line.focus({ preventScroll: true })
    else focusBox()
  }

  // Scrolls the log to a prompt's row. One among the earlier blocks not shown yet shows them
  // first, as far back as it, and is scrolled to once they are there.
  const scrollToTurn = (id: string): void => {
    const index = blocks.findIndex((block) => block.id === id)
    if (index !== -1 && index < shownFrom) {
      pendingTurn.current = (element) => {
        const row = startRows(element, turns.starts).find((each) => each.id === id)
        if (!row) return
        following.current = false
        element.scrollTop = scrollFor(row, logPadding(compact))
      }
      prepended.current = standing()
      admit(() => windowSize)
      // As far back as the prompt, from the whole window: one inside it needs only the rest of it.
      setMore({ session, extra: Math.max(0, blocks.length - index - windowSize) })
    } else {
      const element = scroller.current
      const row = element && startRows(element, turns.starts).find((each) => each.id === id)
      if (element && row) element.scrollTop = scrollFor(row, logPadding(compact))
    }
    // The control pressed may be gone or disabled by the time the log has scrolled: focus stays in
    // the chat, where Esc is heard.
    // Once the held line has followed, in the effect below; a log that was already there leaves
    // no change to wait for.
    refocus.current = true
    setTimeout(() => {
      if (refocus.current) keepFocus()
      refocus.current = false
    }, 250)
  }

  const { held } = turns
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Only as the held line changes.
    keepFocus()
  }, [held])

  const echoes = useEchoes(slice, items)
  // An echo stands where it ran: one from before the blocks shown goes with the earlier ones.
  const shownEchoes = useMemo(() => {
    const since = shownFrom > 0 ? shown.map(blockAt).find((at) => at !== null) : undefined
    return since === undefined || since === null
      ? echoes.shown
      : echoes.shown.filter(({ at }) => at >= since)
  }, [echoes.shown, shown, shownFrom])
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
    setStopError(null)
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

  const stop = (): void => {
    if (stopping) return
    setStopping(true)
    setStopError(null)
    passing
      .leave()
      .then(onInterrupt)
      .then(
        () => mounted.current && setStopping(false),
        (failure: unknown) => {
          if (!mounted.current) return
          setStopping(false)
          setStopError(failed(failure))
        },
      )
  }
  // Esc stops the agent, as it does in its own terminal, unless something has the key: a menu of
  // the harness's own (the box passes it on, or its rows show) or a control that took it.
  const escape = (event: React.KeyboardEvent): void => {
    // An unfolded prompt closes before Esc does anything else.
    if (
      peeking &&
      event.key === "Escape" &&
      !event.defaultPrevented &&
      !event.nativeEvent.isComposing &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault()
      setPeek(null)
      return
    }
    if (
      event.key !== "Escape" ||
      !working ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      passing.on ||
      slice !== null
    )
      return
    event.preventDefault()
    stop()
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
    if (wasTaken.current && !taken && (!active || active === document.body)) focusEntry()
    wasTaken.current = taken
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Only as it comes and goes.
  }, [taken])
  const boxReturn = useBoxReturn(chatSection, taken, focusEntry)

  // The window's phase as the current turn's prompt mark wears it.
  const phase = windowPhase && markPhase(windowPhase)
  // The person's prompt holding the top of the log, if one does.
  const holding = useMemo(() => {
    const block = blocks.find(({ id }) => id === heldId)
    return block?.kind === "user" ? block : null
  }, [blocks, heldId])
  const empty = items.length === 0 && bubbles.length === 0 && shownEchoes.length === 0
  // What an empty chat is: only a conversation the runner proved empty says so; one it can't
  // read, or with something of the agent's own on its screen, shows that screen instead.
  // Before a session binds (Codex and Antigravity bind at a first prompt) there is no record to
  // read, but a screen that isn't at its idle box is as much to show.
  const verdict = emptiness({ loaded, records, rest, turned })
  const unproven =
    session === null
      ? rest === false
        ? { reason: "screen" as const }
        : null
      : verdict.state === "unproven"
        ? verdict
        : null
  return (
    <SliceKeys.Provider value={sliceKeys ?? null}>
      <section
        ref={chatSection}
        className="chat"
        data-compact={compact || undefined}
        aria-label={`${terminalName} chat`}
        onPointerDown={boxReturn.onPointerDown}
        onClick={boxReturn.onClick}
        onKeyDown={escape}
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
              // A step of the window still to draw keeps what is in view as it is now.
              const pending = prepended.current
              if (pending !== null && pending.until !== null)
                prepended.current = standing(pending.until)
              turns.scrolled(event.currentTarget)
            }}
          >
            <div ref={thread} className="chat-thread">
              {shownFrom > 0 && (
                <button
                  type="button"
                  className="button quiet chat-earlier"
                  data-turn={carried?.id}
                  onClick={() => {
                    prepended.current = standing()
                    // From the whole window, as though the rest of it were drawn already.
                    admit(() => windowSize)
                    setMore({ session, extra: extra + windowSize })
                  }}
                >
                  Show earlier messages ({shownFrom})
                </button>
              )}
              {empty &&
                (unproven ? (
                  <Unproven
                    reason={unproven.reason}
                    agent={name}
                    // One copy of the rows, the one that takes keys: a slice of its own, which
                    // draws under the log, is the screen's rows already.
                    screen={slice === null ? screen : null}
                    below={slice !== null}
                    onShowTerminal={onAnswerInTerminal}
                  />
                ) : (
                  <p className="chat-empty" role="status">
                    {session === null
                      ? `No conversation yet. It shows here once ${name} starts its session.`
                      : verdict.state === "loading"
                        ? "Loading the conversation…"
                        : "Nothing said yet. Send a prompt below."}
                  </p>
                ))}
              <ThumbsContext.Provider value={thumbs}>
                <Transcript
                  blocks={shown}
                  agent={name}
                  working={working}
                  gone={agent === undefined}
                  sent={bubbles}
                  echoes={shownEchoes}
                  looks={peerLooks}
                  mention={mention}
                  personFace={personFace}
                  phase={phase}
                  {...(plain &&
                    draft.trim() === "" &&
                    attachments.length === 0 && { onResend: resend })}
                  {...(plain && { onEdit: edit })}
                  onShowTerminal={onAnswerInTerminal}
                />
              </ThumbsContext.Provider>
              {(status || listed.length > 0) && (
                // While the agent works, or a shell runs, the log's last rows: the turn's clock and
                // stop and a line for each shell. They scroll with the log.
                <div className="chat-running" data-working={working || undefined}>
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
                  {working && (
                    <span className="chat-status-end">
                      {turnStart !== null && (
                        <Fact live keep>
                          <Since since={turnStart} />
                        </Fact>
                      )}
                      <button
                        type="button"
                        className="chat-key chat-stop nodrag nopan"
                        aria-label="Stop"
                        aria-disabled={stopping || undefined}
                        onClick={stop}
                      >
                        <kbd>esc</kbd>
                        stop
                      </button>
                    </span>
                  )}
                  <ShellLines
                    shells={listed}
                    tails={shellTails}
                    onShell={onOpenShell}
                    open={shellsOpen}
                    onOpen={setShellsOpen}
                  />
                </div>
              )}
            </div>
          </div>
          {holding && (
            <Hold
              text={holding.text}
              mention={mention}
              at={holding.at}
              offset={turns.held!.offset}
              phase={holding.id === currentPrompt(blocks) ? phase : undefined}
              open={peeking}
              onOpen={() => setPeek(holding.id)}
              onClose={() => setPeek(null)}
              onGo={() => {
                setPeek(null)
                scrollToTurn(holding.id)
              }}
            />
          )}
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
          handle={requestsHandle}
          requests={asked}
          slice={slice}
          agent={name}
          harness={harness}
          onAnswer={answer}
          onAnswerInTerminal={onAnswerInTerminal}
          onSettled={() => {
            // The card that was answered went: the next card or the box takes focus, unless the
            // person moved it.
            const active = document.activeElement
            if (active && active !== document.body) return
            focusEntry()
          }}
          replying={reply?.request ?? null}
          replySending={reply !== null && replyGoing}
          onReply={(request, dialog) => {
            // A new reply takes the words in the box as its own.
            onReplyTo(dialog === null ? null : { request, dialog })
            if (dialog !== null) focusBox()
          }}
          // An answer went from a card: the person's next keys go to a card that never had them,
          // or their words in the box, where they chose to chat about it.
          onSubmitted={(chat) => (chat ? focusBox() : focusEntry())}
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
          stopError={stopError}
          onClearBox={onClearBox}
          focusInput={focusInput}
          onInputFocused={onInputFocused}
          onFocusWanted={claimCard}
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

export type ChatViewProps = Parameters<typeof ChatBody>[0]

// Whether two sets of props are the same, each prop by identity, as `memo` tells.
const sameProps = (before: ChatViewProps, after: ChatViewProps): boolean => {
  const keys = Object.keys(after) as (keyof ChatViewProps)[]
  return (
    keys.length === Object.keys(before).length && keys.every((key) => before[key] === after[key])
  )
}

// The chat as it last drew while it's out of sight: what the app hands it as its agent works (its
// status, the window's phase, the peers' looks) draws it again only once it's back. Its stores
// hold on their own (see ./held), as whether it holds reaches it by context all the same.
const Held = memo(
  ({ held: _held, ...props }: ChatViewProps & { readonly held: boolean }): React.JSX.Element => (
    <ChatBody {...props} />
  ),
  ({ held: _before, ...before }, { held, ...after }) => held || sameProps(before, after),
)

export const ChatView = (props: ChatViewProps): React.JSX.Element => {
  const holds = useHolds()
  return (
    <Holding value={holds}>
      <Held {...props} held={holds} />
    </Holding>
  )
}
