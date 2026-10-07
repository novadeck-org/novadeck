import { Loader } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"

import type {
  ChatAnswer,
  ChatDialog,
  ChatDialogOption,
  ChatFormField,
} from "../../model/conversation"
import {
  controlHint,
  hasControlCharacters,
  promptHint,
  promptRefused,
} from "../../model/prompt-refusal"
import {
  answeredCount,
  chatAnswer,
  holdsControls,
  oneLine,
  choiceAnswer,
  choose,
  complete,
  questionsAnswer,
  reconcile,
  write,
  type Picks,
} from "./answers"
import {
  complete as completeForm,
  enter,
  entryOf,
  formAnswer,
  keep as keepEntries,
  valid as validEntry,
  type Entries,
} from "./forms"
import { Hint } from "./Hint"

// What a request's dialog offers, as controls the person answers with. Each takes `send`,
// which gives the answer to the backend and says nothing until the card shows the outcome,
// and `sending`, which holds the controls while one goes.

type Controls = {
  readonly sending: boolean
  readonly send: (answer: ChatAnswer) => void
  // The person edited something: an error shown for the last answer no longer applies.
  readonly edited: () => void
}

// Enter sends from a text field; Shift+Enter starts a line, a modified Enter belongs to
// the workspace's shortcuts.
const submitOnEnter =
  (submit: () => void, single = false) =>
  (event: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): void => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return
    if (event.shiftKey) {
      // A field of the agent's own takes one line.
      if (single) event.preventDefault()
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return
    event.preventDefault()
    submit()
  }

const Sending = ({ sending }: { readonly sending: boolean }): React.JSX.Element | null =>
  sending ? <Loader size={12} aria-hidden className="chat-spinner" /> : null

// What the protocol takes: the person's words, and a form's text value.
const wordsMax = 16_384
const formTextMax = 4096

const textHint = { field: "Type your answer…", prompt: "Tell it what to do instead…" } as const

const Choices = ({
  dialog,
  sending,
  send,
  edited,
}: Controls & { readonly dialog: Extract<ChatDialog, { type: "choices" }> }): React.JSX.Element => {
  // The option whose words are being written, and the words.
  const [opened, setOpened] = useState<{
    readonly dialog: string
    readonly option: ChatDialogOption
  } | null>(null)
  const [words, setWords] = useState("")
  const field = useRef<HTMLTextAreaElement>(null)
  const label = useId()
  // A dialog read again keeps the option open only if it still means the same: the same
  // label and kind of words. The words typed stay either way.
  const current = dialog.options.find((option) => option.id === opened?.option.id)
  const stays =
    opened !== null &&
    current !== undefined &&
    (opened.dialog === dialog.id ||
      (current.label === opened.option.label && current.text === opened.option.text))
  const open = stays ? current.id : null
  const writing = stays ? current : undefined
  // Words that go on as the agent's next prompt are checked, not those typed in its field.
  const refusedWords = writing?.text === "prompt" && promptRefused(words)
  const controlWords = writing?.text === "field" && hasControlCharacters(words)
  const blockedWords = refusedWords || controlWords
  useEffect(() => {
    if (open !== null) field.current?.focus()
  }, [open])
  const submit = (): void => {
    if (!writing || sending || words.trim() === "" || blockedWords) return
    send(choiceAnswer(dialog.id, writing.id, words))
  }
  return (
    <div className="chat-dialog">
      {dialog.title && (
        <p className="chat-dialog-title" id={label}>
          {dialog.title}
        </p>
      )}
      {dialog.detail && (
        <pre className="chat-detail nodrag nopan nowheel" tabIndex={0} aria-label="What it asks">
          {dialog.detail}
        </pre>
      )}
      <div
        className="chat-options"
        role="group"
        aria-labelledby={dialog.title ? label : undefined}
        aria-label={dialog.title ? undefined : "Answers"}
      >
        {dialog.options.map((option) => (
          <button
            key={option.id}
            type="button"
            className="button chat-option nodrag nopan"
            disabled={sending}
            aria-expanded={option.text ? open === option.id : undefined}
            data-open={open === option.id || undefined}
            onClick={() => {
              edited()
              if (option.text) setOpened(open === option.id ? null : { dialog: dialog.id, option })
              else send(choiceAnswer(dialog.id, option.id))
            }}
          >
            {option.label}
            {option.text && "…"}
          </button>
        ))}
        <Sending sending={sending} />
      </div>
      {writing?.text && (
        <>
          <textarea
            ref={field}
            className="chat-field nodrag nopan"
            aria-label={writing.label}
            aria-describedby={`${label}-hint`}
            placeholder={textHint[writing.text]}
            rows={2}
            maxLength={wordsMax}
            value={words}
            disabled={sending}
            spellCheck
            onChange={(event) => {
              setWords(writing.text === "field" ? oneLine(event.target.value) : event.target.value)
              edited()
            }}
            onKeyDown={submitOnEnter(submit, writing.text === "field")}
          />
          {writing.text === "field" && (
            <p className="chat-field-hint">The agent's field takes one line.</p>
          )}
          <Hint
            id={`${label}-hint`}
            className="chat-field-hint"
            text={refusedWords ? promptHint : controlWords ? controlHint : ""}
          />
          <div className="chat-form-foot">
            <button
              type="button"
              className="button primary chat-submit nodrag nopan"
              disabled={sending || words.trim() === "" || blockedWords}
              onClick={submit}
            >
              <Sending sending={sending} />
              Send answer
            </button>
          </div>
        </>
      )}
    </div>
  )
}

const Questions = ({
  dialog,
  requestId,
  sending,
  send,
  edited,
  replying,
  onReply,
}: Controls & {
  readonly dialog: Extract<ChatDialog, { type: "questions" }>
  readonly requestId: string
  // The chat's box answers this dialog: its words are said to the agent in place of answers.
  readonly replying: boolean
  readonly onReply: (dialog: string | null) => void
}): React.JSX.Element => {
  const [chosen, setPicks] = useState<Picks>({})
  const base = useId()
  const { questions } = dialog
  // A re-read dialog may have lost options the person had picked; their words stay.
  const picks = reconcile(chosen, questions)
  const ready = complete(picks, questions) && !holdsControls(picks, questions)
  const submit = (): void => {
    if (ready && !sending && !replying) send(questionsAnswer(dialog.id, picks, questions))
  }
  // Talking it over: where the words go on as a prompt, the dialog goes at once and the
  // chat's box takes them; where the agent's field takes them, the box answers with them.
  const chat = (): void => {
    edited()
    if (dialog.chat === "prompt") send(chatAnswer(dialog.id, ""))
    else onReply(replying ? null : dialog.id)
  }
  return (
    <form
      className="chat-dialog chat-questions"
      aria-label="Answer the questions"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {replying && (
        <p className="chat-dialog-title">
          The questions are set aside. Your reply in the box below goes to the agent instead.
        </p>
      )}
      {(replying ? [] : questions).map((question, index) => {
        const id = `${base}-${index}`
        const pick = picks[question.id]
        return (
          <fieldset
            key={question.id}
            className="chat-question"
            role={question.multiSelect ? "group" : "radiogroup"}
            aria-labelledby={`${id}-q`}
            disabled={sending}
          >
            <legend id={`${id}-q`} className="chat-question-text">
              {question.header && <span className="chat-request-tag">{question.header}</span>}
              {question.question}
            </legend>
            {question.options.map((option, at) => (
              <div key={option.id} className="chat-choice">
                <label>
                  <input
                    type={question.multiSelect ? "checkbox" : "radio"}
                    name={`${requestId}:${question.id}`}
                    className="nodrag nopan"
                    checked={pick?.options.includes(option.id) ?? false}
                    aria-describedby={option.description ? `${id}-${at}-d` : undefined}
                    onChange={() => {
                      setPicks(choose(picks, question, option.id))
                      edited()
                    }}
                  />
                  <span>{option.label}</span>
                </label>
                {option.description && (
                  <p className="chat-choice-description" id={`${id}-${at}-d`}>
                    {option.description}
                  </p>
                )}
              </div>
            ))}
            {question.text && (
              <input
                type="text"
                maxLength={wordsMax}
                className="chat-field nodrag nopan"
                aria-label={`Other: ${question.question}`}
                aria-describedby={`${id}-other-hint`}
                placeholder="Other…"
                value={pick?.text ?? ""}
                autoComplete="off"
                spellCheck
                onChange={(event) => {
                  setPicks(write(picks, question, event.target.value))
                  edited()
                }}
                onKeyDown={submitOnEnter(submit)}
              />
            )}
            {question.text && (
              <Hint
                id={`${id}-other-hint`}
                className="chat-field-hint"
                text={hasControlCharacters(pick?.text ?? "") ? controlHint : ""}
              />
            )}
          </fieldset>
        )
      })}
      <div className="chat-form-foot">
        {!replying && questions.length > 1 && (
          <span className="chat-progress" role="status">
            {answeredCount(picks, questions)} of {questions.length} answered
          </span>
        )}
        {dialog.chat !== null && (
          <button
            type="button"
            className="button chat-submit nodrag nopan"
            disabled={sending}
            onClick={chat}
          >
            {replying ? "Back to the questions" : "Chat about this"}
          </button>
        )}
        {!replying && (
          <button
            type="submit"
            className="button primary chat-submit nodrag nopan"
            disabled={!ready || sending}
          >
            <Sending sending={sending} />
            Submit
          </button>
        )}
      </div>
    </form>
  )
}

const Form = ({
  dialog,
  sending,
  send,
  edited,
}: Controls & { readonly dialog: Extract<ChatDialog, { type: "form" }> }): React.JSX.Element => {
  const [typed, setEntries] = useState<Entries>({})
  const base = useId()
  const { fields } = dialog
  // A form read again keeps what was entered in the fields that are still there.
  const entries = keepEntries(typed, fields)
  const ready = completeForm(entries, fields)
  const change = (field: ChatFormField, value: string): void => {
    setEntries(enter(entries, field, value))
    edited()
  }
  const answer = (action: "accept" | "decline"): void => {
    if (sending || (action === "accept" && !ready)) return
    send(formAnswer(dialog.id, action, entries, fields))
  }
  return (
    <form
      className="chat-dialog chat-questions"
      aria-label="Fill in the form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        answer("accept")
      }}
    >
      {dialog.message && <p className="chat-dialog-title">{dialog.message}</p>}
      <fieldset className="chat-form-fields" disabled={sending}>
        {fields.map((field, index) => {
          const id = `${base}-${index}`
          const entry = entryOf(entries, field)
          const hintId = `${id}-h`
          const described =
            [field.description ? `${id}-d` : null, field.kind === "text" ? hintId : null]
              .filter(Boolean)
              .join(" ") || undefined
          const mark = field.required && (
            <span aria-hidden className="chat-required">
              {" *"}
            </span>
          )
          const invalid = !validEntry(entries, field)
          return (
            <div key={field.id} className="chat-form-field">
              <label className="chat-form-label" htmlFor={id}>
                {field.label}
                {mark}
              </label>
              {field.kind === "choice" || field.kind === "boolean" ? (
                <select
                  id={id}
                  className="chat-field nodrag nopan"
                  value={entry.value}
                  aria-required={field.required || undefined}
                  aria-describedby={described}
                  onChange={(event) => change(field, event.target.value)}
                >
                  <option value="">{field.kind === "boolean" ? "Not set" : "Choose…"}</option>
                  {(field.kind === "boolean" ? ["yes", "no"] : field.choices).map((choice) => (
                    <option key={choice} value={choice}>
                      {field.kind === "boolean" ? (choice === "yes" ? "Yes" : "No") : choice}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  type={field.kind === "number" ? "number" : "text"}
                  maxLength={field.kind === "text" ? formTextMax : undefined}
                  step={field.kind === "number" ? "any" : undefined}
                  className="chat-field nodrag nopan"
                  value={entry.value}
                  aria-required={field.required || undefined}
                  aria-invalid={invalid || undefined}
                  aria-describedby={described}
                  autoComplete="off"
                  spellCheck={field.kind === "text"}
                  onChange={(event) => change(field, event.target.value)}
                />
              )}
              {field.kind === "text" && (
                <Hint
                  id={hintId}
                  className="chat-field-hint"
                  text={hasControlCharacters(entry.value) ? controlHint : ""}
                />
              )}
              {field.description && (
                <p className="chat-choice-description chat-form-description" id={`${id}-d`}>
                  {field.description}
                </p>
              )}
            </div>
          )
        })}
      </fieldset>
      <div className="chat-form-foot">
        <button
          type="button"
          className="button chat-submit nodrag nopan"
          disabled={sending}
          onClick={() => answer("decline")}
        >
          Decline
        </button>
        <button
          type="submit"
          className="button primary chat-submit nodrag nopan"
          disabled={!ready || sending}
        >
          <Sending sending={sending} />
          Accept
        </button>
      </div>
    </form>
  )
}

const reasons = {
  unrecognized: "Novadeck can't read this dialog. It may have changed in an update.",
  unsupported: "This dialog can't be answered from the chat.",
  failed: "That answer didn't take.",
} as const

const Raw = ({
  dialog,
}: {
  readonly dialog: Extract<ChatDialog, { type: "raw" }>
}): React.JSX.Element => (
  <div className="chat-dialog">
    <p className="chat-raw-reason">{reasons[dialog.reason]}</p>
    <pre className="chat-raw nodrag nopan nowheel" tabIndex={0} aria-label="The dialog's text">
      {dialog.text}
    </pre>
  </div>
)

// The dialog's controls: buttons for choices, a form for questions, the dialog's text for
// one the chat can't answer.
export const RequestDialog = ({
  dialog,
  requestId,
  replying,
  onReply,
  ...controls
}: Controls & {
  readonly dialog: ChatDialog
  readonly requestId: string
  readonly replying: boolean
  readonly onReply: (dialog: string | null) => void
}): React.JSX.Element =>
  dialog.type === "choices" ? (
    <Choices dialog={dialog} {...controls} />
  ) : dialog.type === "questions" ? (
    <Questions
      dialog={dialog}
      requestId={requestId}
      replying={replying}
      onReply={onReply}
      {...controls}
    />
  ) : dialog.type === "form" ? (
    <Form dialog={dialog} {...controls} />
  ) : (
    <Raw dialog={dialog} />
  )
