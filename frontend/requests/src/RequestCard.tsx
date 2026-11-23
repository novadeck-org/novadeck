import type { ChatAnswer, ChatRequest } from "@novadeck/core/conversation"
import type { Refused } from "@novadeck/core/conversation/prompt-refusal"
import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react"

import type { Drafted } from "./drafts"
import type { MenuHandle } from "./Menu"
import { RequestDialog, type DialogSlots, type Live, type RequestPlace } from "./RequestDialog"
import { useMounted } from "./use-mounted"

export type { Diagnostics, Live, RequestPlace } from "./RequestDialog"

// A card's frame: its head (the title line, and what the host puts beside it) over what it holds.
// A request's card is one; the Inbox's own kinds (an agent's ask, a held message, trouble, an
// update) are drawn in it too, so every card reads alike.
export const RequestFrame = ({
  ref,
  kind,
  dialog,
  label,
  title,
  head,
  busy,
  onClick,
  children,
}: {
  readonly ref?: Ref<HTMLElement>
  // What the card is, for its hooks: a request's kind, or the host's own.
  readonly kind: string
  // The type of the dialog it holds, where it holds one.
  readonly dialog?: string
  // Its name, for a screen reader.
  readonly label: string
  readonly title: ReactNode
  // Beside the title, at the head's far end: a clock, a key.
  readonly head?: ReactNode
  readonly busy?: boolean
  readonly onClick?: (event: React.MouseEvent<HTMLElement>) => void
  readonly children?: ReactNode
}): React.JSX.Element => (
  <article
    ref={ref}
    className="request-card"
    data-kind={kind}
    data-dialog={dialog}
    aria-label={label}
    aria-busy={busy}
    onClick={onClick}
  >
    <header className="request-head">
      <h3>{title}</h3>
      {head}
    </header>
    {children}
  </article>
)

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

// What keeps the focus a click gives it: a control, or a field.
const controls =
  'button, a[href], input, textarea, select, summary, label, [role="tab"], [contenteditable]:not([contenteditable="false"])'

// Hands a handle to the host's ref too.
const share = <T,>(ref: Ref<T> | undefined, value: T | null): void => {
  if (typeof ref === "function") ref(value)
  else if (ref) ref.current = value
}

const reason = (failure: unknown): string =>
  failure instanceof Error && failure.message ? failure.message : "That answer didn't go through."

// A mouse's click anywhere on a card (`event.currentTarget`) but a control or a field brings the
// keyboard to its dialog's row the person is on, so the keys answer it from there; a selection
// stays to copy, and what the click focused in the card keeps it, as a box that scrolls by its
// keys. A tap never does, which would raise a phone's keyboard for a field. A host's own card
// that holds a dialog does the same.
export const clickToDialog = (
  event: React.MouseEvent<HTMLElement>,
  dialog: MenuHandle | null,
): void => {
  const { target, nativeEvent, currentTarget } = event
  if (event.detail > 1 || !(target instanceof Element) || target.closest(controls)) return
  const by = "pointerType" in nativeEvent ? nativeEvent.pointerType : ""
  if (by === "touch" || by === "pen") return
  if (window.getSelection()?.isCollapsed === false) return
  const active = document.activeElement
  if (active && active !== document.body && currentTarget.contains(active)) return
  dialog?.focus(false)
}

// A request that waits on the person: what it asks, and the controls of its dialog where the
// backend read it. The way to the agent's terminal shows only where the card has no other: an
// answer it waits on, a dialog not on screen yet, one it can't read and has no live rows of.
export const RequestCard = ({
  ref,
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
  menu,
  arrived = false,
  draft,
  detail,
  harness,
  diagnostics,
}: DialogSlots & {
  // The card's own element, for the host.
  readonly ref?: Ref<HTMLElement> | undefined
  readonly request: ChatRequest
  // The agent's name, for what waits on it.
  readonly agent: string
  // The only way an answer leaves: it settles once the answer took, or fails with why not.
  readonly send: (answer: ChatAnswer) => Promise<void>
  readonly onAnswerInTerminal: () => void
  // The card went after an answer took, with focus nowhere.
  readonly onSettled: () => void
  // The person submitted an answer from the card, with focus in it or nowhere: `answer`, which is
  // a chat to have in the host's box where its type is "chat".
  readonly onSubmitted: (answer: ChatAnswer) => void
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
  // A handle on the dialog's menu the person is on, for the keys the host takes on its own row
  // or title (the Inbox's): a number presses its row, an arrow moves the cursor.
  readonly menu?: Ref<MenuHandle> | undefined
  // The host moved on to this card from an answer (the Inbox, to the next row): focus comes to
  // its dialog, and for a moment no key or click answers it.
  readonly arrived?: boolean
  // Where the host keeps what the person put in the dialog and hasn't sent: absent, the dialog
  // keeps it while it is drawn.
  readonly draft?: Drafted | undefined
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
  const card = useRef<HTMLElement | null>(null)
  const frame = useCallback(
    (element: HTMLElement | null) => {
      card.current = element
      share(ref, element)
    },
    [ref],
  )
  // The dialog's handle, the host's too.
  const dialogHandle = useRef<MenuHandle | null>(null)
  const handle = useCallback(
    (value: MenuHandle | null) => {
      dialogHandle.current = value
      share(menu, value)
    },
    [menu],
  )
  const toDialog = (event: React.MouseEvent<HTMLElement>): void =>
    clickToDialog(event, dialogHandle.current)
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
    if (!active || active === document.body || card.current?.contains(active)) onSubmitted(given)
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
    request.answered ||
    dialog === null ||
    dialog.type === "newer" ||
    (dialog.type === "raw" && !live?.keys)
  return (
    <RequestFrame
      ref={frame}
      kind={request.kind}
      dialog={dialog?.type ?? "none"}
      label={`${title}: ${request.tool}`}
      busy={sending}
      onClick={toDialog}
      title={
        <>
          {title}
          {request.subagent && " · subagent"}
        </>
      }
      head={
        <>
          {!request.answered && clock?.(request.askedAt)}
          {onlyTheTerminal && (
            <button
              type="button"
              className="request-key nodrag nopan"
              aria-label="Answer in terminal"
              onClick={onAnswerInTerminal}
            >
              terminal
            </button>
          )}
        </>
      }
    >
      {request.subject && !saysSubject(request) && (
        <p className="request-subject">{request.subject}</p>
      )}
      {request.answered ? (
        <p ref={status} tabIndex={-1} className="request-answered" role="status">
          <span className="chat-spin" aria-hidden />
          Answered. Waiting for {agent}…
        </p>
      ) : dialog === null ? (
        <>
          {request.choices.length > 0 && (
            <p className="request-choices">
              <span>Options:</span> {request.choices.join(" · ")}
            </p>
          )}
          <p className="request-waiting">Waiting for the dialog…</p>
        </>
      ) : (
        <RequestDialog
          key={handedBackCount}
          dialog={dialog}
          kind={request.kind}
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
          draft={draft}
          arrived={arrived}
          handle={handle}
          detail={detail}
          harness={harness}
          diagnostics={diagnostics}
        />
      )}
      {notice && !request.answered && (
        <p className="request-again" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="chat-error request-error" role="alert">
          {error}
        </p>
      )}
    </RequestFrame>
  )
}
