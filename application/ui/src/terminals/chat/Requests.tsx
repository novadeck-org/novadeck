import { CircleHelp, ClipboardList, Loader, ShieldQuestion, type LucideIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { WordsLost, type ChatAnswer, type ChatRequest } from "../../model/conversation"
import type { Refused } from "../../model/prompt-refusal"
import { RequestDialog } from "./RequestDialog"

const kinds: Readonly<Record<ChatRequest["kind"], { title: string; Icon: LucideIcon }>> = {
  permission: { title: "Needs your permission", Icon: ShieldQuestion },
  question: { title: "Has a question", Icon: CircleHelp },
  plan: { title: "Plan to review", Icon: ClipboardList },
}

// How long after an answer took the same dialog may stay before it counts as another one,
// in milliseconds.
export const againMs = 1000

const reason = (failure: unknown): string =>
  failure instanceof Error && failure.message ? failure.message : "That answer didn't go through."

// A request that waits on the person: what it asks, the controls of its dialog where the
// backend read it, and the way to answer in the agent's terminal instead.
const Card = ({
  request,
  agent,
  onAnswer,
  onAnswerInTerminal,
  onSettled,
  replying,
  replySending,
  onReply,
  onChatting,
  refused,
}: {
  readonly request: ChatRequest
  // The agent's name, for what waits on it.
  readonly agent: string
  readonly onAnswer: (request: string, answer: ChatAnswer) => Promise<void>
  readonly onAnswerInTerminal: () => void
  // The card went after an answer took, with focus nowhere.
  readonly onSettled: () => void
  // Whether the chat's box answers this request's dialog, and is sending that answer.
  readonly replying: boolean
  readonly replySending: boolean
  readonly onReply: (dialog: string | null) => void
  // The dialog was set aside to talk it over: the person's next words go in the box.
  readonly onChatting: () => void
  readonly refused: Refused
}): React.JSX.Element => {
  const { title, Icon } = kinds[request.kind]
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // The request as it is now, for what happens a moment after an answer took.
  const latest = useRef(request)
  useEffect(() => {
    latest.current = request
  })
  const settling = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(settling.current), [])
  // The dialog the notice of an identical request is about.
  // Counts the times the words were handed back to the box, which empties the card's field.
  const [handedBack, setHandedBack] = useState(0)
  const [again, setAgain] = useState<string | null>(null)
  // Focus goes where the person's attention follows once an answer took: the answered line,
  // then the box when the card goes.
  const took = useRef(false)
  const card = useRef<HTMLElement>(null)
  const status = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (!request.answered) return
    took.current = true
    const { activeElement } = document
    if (
      activeElement === document.body ||
      status.current?.closest("article")?.contains(activeElement)
    )
      status.current?.focus({ preventScroll: true })
  }, [request.answered])
  const settled = useRef(onSettled)
  const chatting = useRef(onChatting)
  useEffect(() => {
    settled.current = onSettled
    chatting.current = onChatting
  })
  useEffect(
    () => () => {
      if (took.current) settled.current()
    },
    [],
  )
  const send = (answer: ChatAnswer): void => {
    if (sending) return
    setSending(true)
    setError(null)
    setAgain(null)
    clearTimeout(settling.current)
    const asked = request.dialog && "id" in request.dialog ? request.dialog.id : null
    // Once it took, the request goes and so does this card.
    onAnswer(request.id, answer).then(
      () => {
        if (!mounted.current) return
        took.current = true
        setSending(false)
        // The box takes focus, unless the person moved it out of the card meanwhile.
        const active = document.activeElement
        if (
          answer.type === "chat" &&
          (!active || active === document.body || card.current?.contains(active))
        )
          chatting.current()
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
      },
      (failure: unknown) => {
        if (!mounted.current) return
        setSending(false)
        if (failure instanceof WordsLost) {
          // Answered, though what followed didn't land: the words go to the box to send.
          took.current = true
          setHandedBack((count) => count + 1)
          setError(failure.message)
          return
        }
        setError(reason(failure))
      },
    )
  }
  const { dialog } = request
  return (
    <article
      ref={card}
      className="chat-request"
      data-kind={request.kind}
      data-dialog={dialog?.type ?? "none"}
      aria-label={`${title}: ${request.tool}`}
      aria-busy={sending}
    >
      <header className="chat-request-head">
        <Icon size={14} strokeWidth={1.75} aria-hidden />
        <h3>{title}</h3>
        <span className="chat-request-tool">{request.tool}</span>
        {request.subagent && <span className="chat-request-tag">subagent</span>}
        <button type="button" className="button nodrag nopan" onClick={onAnswerInTerminal}>
          Answer in terminal
        </button>
      </header>
      {request.subject && !(dialog?.type === "choices" && dialog.detail === request.subject) && (
        <p className="chat-request-subject">{request.subject}</p>
      )}
      {request.answered ? (
        <p ref={status} tabIndex={-1} className="chat-request-answered" role="status">
          <Loader size={12} aria-hidden className="chat-spinner" />
          Answered. Waiting for {agent}…
        </p>
      ) : dialog === null ? (
        <>
          {request.choices.length > 0 && (
            <p className="chat-request-choices">
              <span>Options:</span> {request.choices.join(" · ")}
            </p>
          )}
          <p className="chat-request-waiting">Waiting for the dialog…</p>
        </>
      ) : (
        <RequestDialog
          key={handedBack}
          dialog={dialog}
          requestId={request.id}
          replying={replying}
          onReply={onReply}
          // While the box's answer goes, the card answers nothing else.
          refused={refused}
          sending={sending || (replying && replySending)}
          send={send}
          edited={() => {
            if (error !== null) setError(null)
            if (again !== null) setAgain(null)
          }}
        />
      )}
      {again !== null && !request.answered && dialog && "id" in dialog && dialog.id === again && (
        <p className="chat-request-again" role="status">
          Another identical request. Answer it too, or answer in the terminal.
        </p>
      )}
      {error && (
        <p className="chat-error chat-request-error" role="alert">
          {error}
        </p>
      )}
    </article>
  )
}

// What waits on the person. The dialog's controls answer it here; "Answer in terminal"
// stays on every card, for a dialog the chat can't answer and for the person's choice.
export const Requests = ({
  requests,
  agent,
  onAnswer,
  onAnswerInTerminal,
  onSettled,
  replying,
  replySending,
  onReply,
  onChatting,
  refused,
}: {
  readonly requests: readonly ChatRequest[]
  readonly agent: string
  readonly onAnswer: (request: string, answer: ChatAnswer) => Promise<void>
  readonly onAnswerInTerminal: () => void
  readonly onSettled: () => void
  // The request whose dialog the chat's box answers, and the way to start or end that.
  readonly replying: string | null
  readonly replySending: boolean
  readonly onReply: (request: string, dialog: string | null) => void
  readonly onChatting: () => void
  // Whether words that go on as the agent's next prompt would be refused for their shape.
  readonly refused: Refused
}): React.JSX.Element | null =>
  requests.length === 0 ? null : (
    <section className="chat-requests" aria-label="Waiting for you">
      {requests.map((request) => (
        <Card
          key={request.id}
          request={request}
          agent={agent}
          onAnswer={onAnswer}
          onAnswerInTerminal={onAnswerInTerminal}
          onSettled={onSettled}
          replying={replying === request.id}
          replySending={replySending}
          onReply={(dialog) => onReply(request.id, dialog)}
          onChatting={onChatting}
          refused={refused}
        />
      ))}
    </section>
  )
