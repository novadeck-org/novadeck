import {
  WordsLost,
  type ChatAnswer,
  type ChatRequest,
  type ChatSlice,
} from "@novadeck/core/conversation"
import type { Refused } from "@novadeck/core/conversation/prompt-refusal"
import type { MenuHandle } from "@novadeck/requests/Menu"
import { RequestCard, type RequestPlace } from "@novadeck/requests/RequestCard"
import { useMounted } from "@novadeck/requests/use-mounted"
import {
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react"

import { Fact, Since } from "./Fact"
import { LiveSlice, SliceKeys } from "./Slice"

// How long after an answer took the same dialog may stay before it counts as another one,
// in milliseconds.
export const againMs = 1000

// A dialog takes focus from anywhere in the chat that holds none of the person's words, and its
// pages scroll with the requests.
const place: RequestPlace = {
  area: (dialog) => dialog.closest(".chat"),
  scroller: (dialog) => dialog.closest(".chat-requests"),
}

const clock = (askedAt: number): React.ReactNode => (
  <Fact keep>
    <Since since={askedAt} before="asked " after=" ago" />
  </Fact>
)

const handedBack = (failure: unknown): boolean => failure instanceof WordsLost

// The dialogs that have had the keyboard, by request, when it was asked, and dialog: each comes
// to it once, as it first shows or as the chat next gives the keyboard out, and never again. The
// newest are kept, far more than all the chats on screen show at once.
const claimed = new Set<string>()
const claimedKept = 200
const claim = (key: string): void => {
  claimed.delete(key)
  claimed.add(key)
  for (const old of claimed) {
    if (claimed.size <= claimedKept) break
    claimed.delete(old)
  }
}

// Forgets every dialog that had the keyboard, for tests that show the same one afresh.
export const forgetClaimed = (): void => claimed.clear()

// Whether focus is free for a dialog that first shows in `chat`: on nothing, or in the chat on
// what holds none of the person's words and isn't in another request's card.
const free = (chat: Element | null): boolean => {
  const active = document.activeElement
  if (!active || active === document.body) return true
  const words =
    (active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLInputElement &&
        (active.type === "text" || active.type === "search"))) &&
    active.value !== ""
  return Boolean(chat?.contains(active)) && !active.closest(".chat-requests") && !words
}

export type RequestsHandle = {
  // Brings the keyboard to the first card whose dialog never had it: true where one took it.
  readonly claim: () => boolean
}

// A request's card in the chat: the terminal's live rows where the chat has them, the words of
// an answer that took without them handed back to the box, and a note when the same dialog is
// still there a moment after an answer took.
const Card = ({
  request,
  slice,
  agent,
  harness,
  onAnswer,
  onAnswerInTerminal,
  onSettled,
  replying,
  replySending,
  onReply,
  onSubmitted,
  refused,
  claims,
}: {
  readonly request: ChatRequest
  readonly slice: ChatSlice | null
  // The agent's name, for what waits on it.
  readonly agent: string
  // Its harness, by its own name, for what the dialog's fields refuse.
  readonly harness: string | null
  readonly onAnswer: (request: string, answer: ChatAnswer) => Promise<void>
  readonly onAnswerInTerminal: () => void
  // The card went after an answer took, with focus nowhere.
  readonly onSettled: () => void
  // Whether the chat's box answers this request's dialog, and is sending that answer.
  readonly replying: boolean
  readonly replySending: boolean
  readonly onReply: (dialog: string | null) => void
  // The person submitted an answer from the card: what they type next goes in the box, or to a
  // card that never had the keyboard, but for a chat about the dialog (`chat`), which is the box's.
  readonly onSubmitted: (chat: boolean) => void
  readonly refused: Refused
  // Where the card puts its way to take the keyboard, for the chat to give it before the box.
  readonly claims: (request: string, take: (() => boolean) | null) => void
}): React.JSX.Element => {
  const keys = useContext(SliceKeys)
  // The keyboard comes to a dialog the first time it shows, from anywhere in the chat that holds
  // none of the person's words, before the box takes it, and for a moment no key answers it.
  const handle = useRef<MenuHandle | null>(null)
  const frame = useRef<HTMLElement>(null)
  const dialogKey =
    request.dialog && !request.answered
      ? `${request.id}\n${request.askedAt}\n${"id" in request.dialog ? request.dialog.id : request.dialog.type}`
      : null
  const latestKey = useRef(dialogKey)
  useEffect(() => {
    latestKey.current = dialogKey
  })
  // It took the keyboard in this task, as it showed: the box, asked for it as the chat shows,
  // leaves it there.
  const justTook = useRef(false)
  const take = (): boolean => {
    const key = latestKey.current
    const holds = Boolean(frame.current?.contains(document.activeElement))
    if (key === null || replying) return false
    if (claimed.has(key)) return justTook.current && holds
    // A dialog that took the keyboard itself, as the questions do, has had it.
    if (!holds && !handle.current?.focus(true)) return false
    claim(key)
    justTook.current = true
    setTimeout(() => {
      justTook.current = false
    })
    return true
  }
  const takeNow = useRef(take)
  useEffect(() => {
    takeNow.current = take
  })
  const { id } = request
  useEffect(() => {
    claims(id, () => takeNow.current())
    return () => claims(id, null)
  }, [claims, id])
  useEffect(() => {
    const card = frame.current
    if (dialogKey === null || !card) return
    if (card.contains(document.activeElement) || free(card.closest(".chat"))) takeNow.current()
  }, [dialogKey])
  const mounted = useMounted()
  // The request as it is now, for what happens a moment after an answer took.
  const latest = useRef(request)
  useEffect(() => {
    latest.current = request
  })
  const settling = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(settling.current), [])
  // The dialog the notice of an identical request is about.
  const [again, setAgain] = useState<string | null>(null)
  const send = (answer: ChatAnswer): Promise<void> => {
    setAgain(null)
    clearTimeout(settling.current)
    const asked = request.dialog && "id" in request.dialog ? request.dialog.id : null
    return onAnswer(request.id, answer).then(() => {
      if (!mounted.current) return
      // Identical calls the agent queued fold into one request: if the same dialog is
      // still here after a moment, say so, or the card looks as if nothing happened.
      clearTimeout(settling.current)
      settling.current = setTimeout(() => {
        const now = latest.current.dialog
        if (
          mounted.current &&
          asked !== null &&
          !latest.current.answered &&
          now &&
          "id" in now &&
          now.id === asked
        )
          setAgain(asked)
      }, againMs)
    })
  }
  const { dialog } = request
  return (
    <RequestCard
      ref={frame}
      menu={handle}
      request={request}
      agent={agent}
      harness={harness}
      send={send}
      onAnswerInTerminal={onAnswerInTerminal}
      onSettled={onSettled}
      onSubmitted={(answer) => {
        // Answered, it has had the keyboard: what comes next is another's, or the box's.
        if (dialogKey !== null) claim(dialogKey)
        justTook.current = false
        onSubmitted(answer.type === "chat")
      }}
      onEdited={() => {
        if (again !== null) setAgain(null)
      }}
      refused={refused}
      place={place}
      live={
        slice?.reason === "dialog"
          ? { rows: <LiveSlice slice={slice} agent={agent} />, keys: keys !== null }
          : undefined
      }
      clock={clock}
      notice={
        again !== null && dialog && "id" in dialog && dialog.id === again
          ? "Another identical request. Answer it too."
          : null
      }
      handedBack={handedBack}
      replying={replying}
      replySending={replySending}
      onReply={onReply}
    />
  )
}

// What waits on the person, as the next lines of the terminal. The dialog's controls answer it
// here.
export const Requests = ({
  handle,
  requests,
  slice,
  agent,
  harness = null,
  onAnswer,
  onAnswerInTerminal,
  onSettled,
  replying,
  replySending,
  onReply,
  onSubmitted,
  refused,
}: {
  // The chat's way to give the keyboard to a card before its box.
  readonly handle?: Ref<RequestsHandle>
  readonly requests: readonly ChatRequest[]
  // The terminal's own rows, for a dialog no adapter read.
  readonly slice: ChatSlice | null
  readonly agent: string
  // The agent's harness, by its own name (`Conversation.agent`), where known.
  readonly harness?: string | null
  readonly onAnswer: (request: string, answer: ChatAnswer) => Promise<void>
  readonly onAnswerInTerminal: () => void
  readonly onSettled: () => void
  // The request whose dialog the chat's box answers, and the way to start or end that.
  readonly replying: string | null
  readonly replySending: boolean
  readonly onReply: (request: string, dialog: string | null) => void
  readonly onSubmitted: (chat: boolean) => void
  // Whether words that go on as the agent's next prompt would be refused for their shape.
  readonly refused: Refused
}): React.JSX.Element | null => {
  // Each card's way to take the keyboard, by its request.
  const takers = useRef(new Map<string, () => boolean>())
  const order = useRef(requests)
  useEffect(() => {
    order.current = requests
  })
  useImperativeHandle(handle, () => ({
    claim: () => order.current.some(({ id }) => takers.current.get(id)?.() ?? false),
  }))
  const claims = useCallback((id: string, take: (() => boolean) | null): void => {
    if (take) takers.current.set(id, take)
    else takers.current.delete(id)
  }, [])
  return requests.length === 0 ? null : (
    <section className="chat-requests" aria-label="Waiting for you">
      {requests.map((request) => (
        <Card
          key={request.id}
          claims={claims}
          request={request}
          slice={slice}
          agent={agent}
          harness={harness}
          onAnswer={onAnswer}
          onAnswerInTerminal={onAnswerInTerminal}
          onSettled={onSettled}
          replying={replying === request.id}
          replySending={replySending}
          onReply={(dialog) => onReply(request.id, dialog)}
          onSubmitted={onSubmitted}
          refused={refused}
        />
      ))}
    </section>
  )
}
