import {
  answeredCount,
  choose,
  complete,
  questionsAnswer,
  write,
  type Picks,
} from "@novadeck/core/answers"
import type { ChatQuestion } from "@novadeck/core/conversation"
import type { AgentAsk, AskOption } from "@novadeck/core/inbox"
import { Markdown } from "@novadeck/toolkit/Markdown"
import { useState, type ReactNode } from "react"

import { Unanswerable } from "./ApproveSheet"
import { agentName, recommended } from "./inbox-text"
import { noDraft, useInboxContext } from "./InboxProvider"
import { Lead, Page, type SheetContentProps } from "./Page"
import { CommandCard, Disclosure, Failure, QuietLink, ReplyBox, Sent, Text } from "./sheet-parts"

// Ask: what the agent asks, as an entry, and the answer it asked for: its options as
// cards, something only the person can do, or words. The person may always
// write their own.

const letters = "ABCDEFGHIJ"

type Card = {
  readonly id: string
  readonly title: string
  readonly pick: boolean
  readonly summary: string | null
  readonly picked: boolean
  readonly more?: ReactNode
}

// An option as a card the person picks by pressing it. `more` is behind its Details.
const Cards = ({
  label,
  cards,
  onPick,
  disabled,
}: {
  readonly label: string
  readonly cards: readonly Card[]
  readonly onPick: (id: string) => void
  readonly disabled: boolean
}): React.JSX.Element => (
  <div className="inbox-options" role="group" aria-label={label}>
    {cards.map((card, index) => (
      <div className="inbox-option" key={card.id} data-picked={card.picked}>
        <button
          type="button"
          className="inbox-option-head"
          aria-pressed={card.picked}
          disabled={disabled}
          onClick={() => onPick(card.id)}
        >
          <span className="inbox-option-key" aria-hidden="true">
            {letters[index] ?? index + 1}
          </span>
          <span className="inbox-option-copy">
            <span className="inbox-option-title text-body">
              <Text text={card.title} />
              {card.pick && (
                <span className="badge inbox-tag" data-tone="success">
                  Its pick
                </span>
              )}
            </span>
            {card.summary && (
              <span className="inbox-option-summary text-control">{card.summary}</span>
            )}
          </span>
        </button>
        {card.more && (
          <div className="inbox-option-more">
            <Disclosure label="Details" openLabel="Hide details">
              {card.more}
            </Disclosure>
          </div>
        )}
      </div>
    ))}
  </div>
)

const optionDetails = (option: AskOption): ReactNode =>
  option.details || option.code ? (
    <div className="inbox-option-details">
      {option.details && <Markdown text={option.details} />}
      {option.code && (
        <>
          <span className="inbox-snippet-path">{option.code.path}</span>
          <pre className="inbox-snippet" tabIndex={0} aria-label={`Code for ${option.code.path}`}>
            {option.code.text}
          </pre>
        </>
      )}
    </div>
  ) : undefined

// An entry: its subject, what makes the answer hard to take back, its body and, behind
// "More detail", the rest.
const Entry = (
  props: SheetContentProps & { readonly ask: AgentAsk; readonly children?: ReactNode },
): React.JSX.Element => {
  const { ask, children } = props
  return (
    <>
      <Lead {...props} />
      {ask.hardToUndo && <span className="inbox-hard">Hard to undo: {ask.hardToUndo}</span>}
      {ask.body.trim() !== "" && (
        <div className="inbox-prose">
          <Markdown text={ask.body} />
        </div>
      )}
      {ask.details && (
        <Disclosure label="More detail">
          <div className="inbox-prose inbox-detail">
            <Markdown text={ask.details} />
          </div>
        </Disclosure>
      )}
      {children}
    </>
  )
}

// What the agent asked through Novadeck's `ask` tool.
const Asked = (props: SheetContentProps & { readonly ask: AgentAsk }): React.JSX.Element => {
  const { item, ask, sent, answering, failed, onNext, submit } = props
  const { drafts, setDraft } = useInboxContext()
  const agent = agentName(item.source.agent)
  const [replying, setReplying] = useState(false)
  // What was started and not sent, which opening the item again finds as it was left.
  const draft = drafts[item.id] ?? noDraft
  const picked = draft.option
  const setPicked = (option: number | null): void => setDraft(item.id, { option })
  const text = draft.text
  const reply = (option: number | null, words: string): void =>
    submit(
      { kind: "ask", answer: { type: "reply", option, text: words.trim() } },
      `Reply queued for ${agent} in @${item.source.handle}.`,
    )
  const { shape } = ask
  const footerReply = (
    <ReplyBox
      value={text}
      onChange={(next) => setDraft(item.id, { text: next })}
      onSend={() => reply(picked, text)}
      placeholder={
        shape.type === "options"
          ? "Add a note to your pick, or write your own answer…"
          : `Reply to ${agent}…`
      }
      label={`Reply to ${agent}`}
      canSend={!answering && (picked !== null || text.trim() !== "")}
      sendLabel={picked === null ? "Send" : `Send ${letters[picked]}`}
    />
  )
  const inline = (
    <>
      <ReplyBox
        value={text}
        onChange={(next) => setDraft(item.id, { text: next })}
        onSend={() => reply(null, text)}
        placeholder={`Reply to ${agent} instead…`}
        label={`Reply to ${agent}`}
        canSend={!answering && text.trim() !== ""}
        onCancel={() => setReplying(false)}
        autoFocus
        minRows={2}
      />
      <div className="inbox-quiet-links">
        <QuietLink onClick={() => setReplying(false)}>Cancel</QuietLink>
      </div>
    </>
  )
  const replyInstead = !sent && (
    <>
      {replying ? (
        inline
      ) : (
        <div className="inbox-quiet-links">
          <QuietLink onClick={() => setReplying(true)}>Reply instead</QuietLink>
        </div>
      )}
    </>
  )
  const footer =
    !sent && (shape.type === "options" || shape.type === "text") ? footerReply : undefined
  return (
    <Page footer={footer}>
      <Entry {...props} ask={ask}>
        {!sent && shape.type === "options" && (
          <Cards
            label="Its options"
            disabled={answering}
            onPick={(id) => setPicked(picked === Number(id) ? null : Number(id))}
            cards={shape.options.map((option, index) => ({
              id: String(index),
              title: recommended(option.label).label,
              pick: shape.recommend === index || recommended(option.label).pick,
              summary: option.summary,
              picked: picked === index,
              more: optionDetails(option),
            }))}
          />
        )}
        {!sent && shape.type === "action" && (
          <>
            <div className="inbox-card">
              <span className="inbox-card-label">Run this yourself</span>
              <CommandCard
                folder={shape.directory}
                command={shape.command}
                copy
                small
                tone="calm"
              />
              <div className="inbox-actions">
                <button
                  type="button"
                  className="button primary text-control"
                  disabled={answering}
                  onClick={() =>
                    submit(
                      { kind: "ask", answer: { type: "done" } },
                      `Reply queued for ${agent}: it's done.`,
                    )
                  }
                >
                  {shape.doneLabel}
                </button>
              </div>
            </div>
            {replyInstead}
          </>
        )}
        <Failure message={failed} />
        {sent && <Sent note={sent.note} onNext={onNext} />}
      </Entry>
    </Page>
  )
}

// The questions in an agent's own dialog, answered through it.
const Questions = (
  props: SheetContentProps & {
    readonly dialog: string
    readonly questions: readonly ChatQuestion[]
  },
): React.JSX.Element => {
  const { item, dialog, questions, sent, answering, failed, onNext, submit } = props
  const { drafts, setDraft } = useInboxContext()
  const agent = agentName(item.source.agent)
  // The picks and words, which are kept as a draft: reopening the item finds them again.
  const picks: Picks = drafts[item.id]?.picks ?? {}
  const setPicks = (next: Picks): void => setDraft(item.id, { picks: next })
  // The person's own words go to the first question that takes them.
  const wordy = questions.find((question) => question.text)
  const text = wordy ? (picks[wordy.id]?.text ?? "") : ""
  const letter = questions.length === 1 ? picks[questions[0]!.id]?.options[0] : undefined
  const at =
    letter === undefined ? -1 : questions[0]!.options.findIndex((each) => each.id === letter)
  const send = (): void =>
    submit(
      { kind: "request", answer: questionsAnswer(dialog, picks, questions) },
      `Sent to ${agent} in @${item.source.handle}. It's working again.`,
    )
  const pick = (question: ChatQuestion, option: string): void =>
    setPicks(
      picks[question.id]?.options.includes(option) && !question.multiSelect
        ? { ...picks, [question.id]: { options: [], text: picks[question.id]?.text ?? "" } }
        : choose(picks, question, option),
    )
  // Several questions say how many have an answer, beside Send, which waits for all of them.
  const progress = questions.length > 1 && (
    <p className="inbox-caption inbox-progress" role="status">
      {answeredCount(picks, questions)} of {questions.length} answered
    </p>
  )
  return (
    <Page
      footer={
        sent ? undefined : wordy ? (
          <>
            {progress}
            <ReplyBox
              value={text}
              onChange={(next) => {
                setPicks(write(picks, wordy, next))
              }}
              onSend={send}
              placeholder="Or type your own answer…"
              label={`Reply to ${agent}`}
              canSend={!answering && complete(picks, questions)}
              sendLabel={at >= 0 ? `Send ${letters[at]}` : "Send"}
            />
          </>
        ) : (
          <>
            {progress}
            <button
              type="button"
              className="button primary text-control"
              disabled={answering || !complete(picks, questions)}
              onClick={send}
            >
              Send
            </button>
          </>
        )
      }
    >
      <Lead {...props} />
      {!sent &&
        questions.map((question) => (
          <div className="inbox-question" key={question.id}>
            {questions.length > 1 && (
              <p className="inbox-question-text">
                {question.header && <span className="inbox-caption">{question.header} · </span>}
                {question.question}
              </p>
            )}
            <Cards
              label={question.question}
              disabled={answering}
              onPick={(id) => pick(question, id)}
              cards={question.options.map((option) => ({
                id: option.id,
                title: recommended(option.label).label,
                pick: recommended(option.label).pick,
                summary: option.description,
                picked: picks[question.id]?.options.includes(option.id) ?? false,
              }))}
            />
          </div>
        ))}
      <Failure message={failed} />
      {sent && <Sent note={sent.note} onNext={onNext} />}
    </Page>
  )
}

export const AskSheet = (props: SheetContentProps): React.JSX.Element | null => {
  const { item } = props
  if (item.kind === "ask") return <Asked {...props} ask={item.ask} />
  if (item.kind !== "request") return null
  const { dialog } = item.request
  if (dialog?.type === "questions")
    return <Questions {...props} dialog={dialog.id} questions={dialog.questions} />
  return <Unanswerable {...props} text={dialog?.type === "raw" ? dialog.text : null} />
}
