import {
  WordsLost,
  type ChatAnswer,
  type ChatRequest,
  type ChatSlice,
} from "@novadeck/core/conversation"
import type { Refused } from "@novadeck/core/conversation/prompt-refusal"
import { RequestCard, type RequestPlace } from "@novadeck/requests/RequestCard"
import { useMounted } from "@novadeck/requests/use-mounted"
import { useContext, useEffect, useRef, useState } from "react"

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

// A request's card in the chat: the terminal's live rows where the chat has them, the words of
// an answer that took without them handed back to the box, and a note when the same dialog is
// still there a moment after an answer took.
const Card = ({
  request,
  slice,
  agent,
  onAnswer,
  onAnswerInTerminal,
  onSettled,
  replying,
  replySending,
  onReply,
  onSubmitted,
  refused,
}: {
  readonly request: ChatRequest
  readonly slice: ChatSlice | null
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
  // The person submitted an answer from the card: what they type next goes in the box.
  readonly onSubmitted: () => void
  readonly refused: Refused
}): React.JSX.Element => {
  const keys = useContext(SliceKeys)
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
      request={request}
      agent={agent}
      send={send}
      onAnswerInTerminal={onAnswerInTerminal}
      onSettled={onSettled}
      onSubmitted={onSubmitted}
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
  requests,
  slice,
  agent,
  onAnswer,
  onAnswerInTerminal,
  onSettled,
  replying,
  replySending,
  onReply,
  onSubmitted,
  refused,
}: {
  readonly requests: readonly ChatRequest[]
  // The terminal's own rows, for a dialog no adapter read.
  readonly slice: ChatSlice | null
  readonly agent: string
  readonly onAnswer: (request: string, answer: ChatAnswer) => Promise<void>
  readonly onAnswerInTerminal: () => void
  readonly onSettled: () => void
  // The request whose dialog the chat's box answers, and the way to start or end that.
  readonly replying: string | null
  readonly replySending: boolean
  readonly onReply: (request: string, dialog: string | null) => void
  readonly onSubmitted: () => void
  // Whether words that go on as the agent's next prompt would be refused for their shape.
  readonly refused: Refused
}): React.JSX.Element | null =>
  requests.length === 0 ? null : (
    <section className="chat-requests" aria-label="Waiting for you">
      {requests.map((request) => (
        <Card
          key={request.id}
          request={request}
          slice={slice}
          agent={agent}
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
