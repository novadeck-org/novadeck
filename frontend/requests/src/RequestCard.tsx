import type { ChatAnswer, ChatRequest } from "@novadeck/core/conversation"
import type { Refused } from "@novadeck/core/conversation/prompt-refusal"
import { useEffect, useRef, useState } from "react"

import { RequestDialog, type Live, type RequestPlace } from "./RequestDialog"
import { useMounted } from "./use-mounted"

export type { Live, RequestPlace } from "./RequestDialog"

const titles: Readonly<Record<ChatRequest["kind"], string>> = {
  permission: "Needs your permission",
  question: "Has a question",
  plan: "Plan to review",
}

// Whether the card already shows the request's subject, in its dialog. A question tool's subject
// is its first question, which the dialog's own page shows, and over the other pages it would
// name the wrong one. Once answered the dialog goes, and the subject says what was asked.
const saysSubject = ({ dialog, answered, subject }: ChatRequest): boolean =>
  !answered &&
  (dialog?.type === "questions" || (dialog?.type === "choices" && dialog.detail === subject))

const reason = (failure: unknown): string =>
  failure instanceof Error && failure.message ? failure.message : "That answer didn't go through."

// A request that waits on the person: what it asks, and the controls of its dialog where the
// backend read it. The way to the agent's terminal shows only where the card has no other: an
// answer it waits on, a dialog not on screen yet, one it can't read and has no live rows of.
export const RequestCard = ({
  request,
  agent,
  send: answer,
  onAnswerInTerminal,
  onSettled,
  onSubmitted,
  onEdited,
  refused,
  place,
  live,
  clock,
  notice,
  handedBack,
  replying = false,
  replySending = false,
  onReply,
}: {
  readonly request: ChatRequest
  // The agent's name, for what waits on it.
  readonly agent: string
  // The only way an answer leaves: it settles once the answer took, or fails with why not.
  readonly send: (answer: ChatAnswer) => Promise<void>
  readonly onAnswerInTerminal: () => void
  // The card went after an answer took, with focus nowhere.
  readonly onSettled: () => void
  // The person submitted an answer from the card, with focus in it or nowhere.
  readonly onSubmitted: () => void
  // The person edited something in the dialog.
  readonly onEdited?: () => void
  // Whether words that go on as the agent's next prompt would be refused for their shape.
  readonly refused: Refused
  // Where the card sits in its host, for the focus and scrolling its dialog does.
  readonly place: RequestPlace
  // The terminal's own rows of a dialog no adapter read, where the host has them.
  readonly live?: Live | undefined
  // How long the request has waited, from when it was asked, in the host's own look and clock.
  readonly clock?: (askedAt: number) => React.ReactNode
  // A line the host has to say under the dialog, as of a request that came again.
  readonly notice?: string | null
  // Whether a failed answer took all the same, its words handed elsewhere to send: the dialog's
  // fields empty, and the failure's message shows.
  readonly handedBack?: (failure: unknown) => boolean
  // Whether the host's own box answers this request's dialog, and is sending that answer, and
  // the way to start or end that. Without `onReply` only a dialog whose words go on as the
  // agent's prompt offers to talk it over.
  readonly replying?: boolean
  readonly replySending?: boolean
  readonly onReply?: ((dialog: string | null) => void) | undefined
}): React.JSX.Element => {
  const title = titles[request.kind]
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useMounted()
  // Counts the times the words were handed back, which empties the card's fields.
  const [handedBackCount, setHandedBack] = useState(0)
  // Focus goes to the host's next place as the person submits an answer here. An answer that took
  // otherwise, as in the terminal, puts it on the answered line where it was in the card, and on
  // the host's next place once the card goes.
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
  useEffect(() => {
    settled.current = onSettled
  })
  useEffect(
    () => () => {
      if (took.current) settled.current()
    },
    [],
  )
  const send = (given: ChatAnswer): void => {
    if (sending) return
    setSending(true)
    setError(null)
    // The person's next words go to the host's next place, unless they have moved focus out of
    // the card.
    const active = document.activeElement
    if (!active || active === document.body || card.current?.contains(active)) onSubmitted()
    // Once it took, the request goes and so does this card.
    answer(given).then(
      () => {
        if (!mounted.current) return
        took.current = true
        setSending(false)
      },
      (failure: unknown) => {
        if (!mounted.current) return
        setSending(false)
        if (handedBack?.(failure)) {
          // Answered, though what followed didn't land: the words went elsewhere to send.
          took.current = true
          setHandedBack((count) => count + 1)
        }
        setError(reason(failure))
      },
    )
  }
  const { dialog } = request
  const onlyTheTerminal =
    request.answered || dialog === null || (dialog.type === "raw" && !live?.keys)
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
        <h3>
          {title}
          {request.subagent && " · subagent"}
        </h3>
        {!request.answered && clock?.(request.askedAt)}
        {onlyTheTerminal && (
          <button
            type="button"
            className="chat-key nodrag nopan"
            aria-label="Answer in terminal"
            onClick={onAnswerInTerminal}
          >
            terminal
          </button>
        )}
      </header>
      {request.subject && !saysSubject(request) && (
        <p className="chat-request-subject">{request.subject}</p>
      )}
      {request.answered ? (
        <p ref={status} tabIndex={-1} className="chat-request-answered" role="status">
          <span className="chat-spin" aria-hidden />
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
          key={handedBackCount}
          dialog={dialog}
          live={live}
          place={place}
          replying={replying}
          onReply={onReply}
          // While the box's answer goes, the card answers nothing else.
          refused={refused}
          sending={sending || (replying && replySending)}
          send={send}
          edited={() => {
            if (error !== null) setError(null)
            onEdited?.()
          }}
        />
      )}
      {notice && !request.answered && (
        <p className="chat-request-again" role="status">
          {notice}
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
