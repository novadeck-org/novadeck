import type {
  ChatAnswer,
  ChatDialog,
  ChatDialogOption,
  ChatFormField,
  ChatQuestion,
} from "@novadeck/core/conversation"
import {
  answered,
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
  type Pick,
  type Picks,
} from "@novadeck/core/conversation/picks"
import {
  controlHint,
  hasControlCharacters,
  promptHint,
  type Refused,
} from "@novadeck/core/conversation/prompt-refusal"
import { useEffect, useId, useRef, useState } from "react"

import {
  enter,
  entryOf,
  entryValid,
  formAnswer,
  formComplete,
  keptEntries,
  type Entries,
} from "./forms"
import { Hint } from "./Hint"
import { shownControls } from "./shown-controls"
import { submitOnEnter } from "./submit-on-enter"
import { holdsWords, isTyping, useMenu, type Menu } from "./use-menu"

// What a request's dialog offers, as the next lines of the terminal: numbered rows, a thin bar on
// the one the person is on. Each takes `send`, which gives the answer to the backend and says
// nothing until the card shows the outcome, and `sending`, which holds the controls while one
// goes.

// The terminal's own rows of a dialog no adapter read, live, as the host draws them, and whether
// the person's keys reach the terminal from them.
export type Live = {
  readonly rows: React.ReactNode
  readonly keys: boolean
}

// Where a request sits in its host: the part of the page whose focus a dialog may take as it
// appears, where that focus holds no words of the person's, and what scrolls the request.
export type RequestPlace = {
  readonly area: (dialog: Element) => Element | null
  readonly scroller: (dialog: Element) => Element | null
}

type Controls = {
  // Whether words that go on as the agent's next prompt would be refused for their shape.
  readonly refused: Refused
  readonly sending: boolean
  readonly send: (answer: ChatAnswer) => void
  // The person edited something: an error shown for the last answer no longer applies.
  readonly edited: () => void
}

const Sending = ({ sending }: { readonly sending: boolean }): React.JSX.Element | null =>
  sending ? (
    <span className="chat-sending" aria-hidden>
      {" "}
      …
    </span>
  ) : null

// What the protocol takes: the person's words, and a form's text value.
const wordsMax = 16_384
const formTextMax = 4096

const textHint = { field: "Type your answer…", prompt: "Tell it what to do instead…" } as const

// A row of a menu, as a button.
const Row = ({
  menu,
  index,
  children,
  ...button
}: {
  readonly menu: Menu
  readonly index: number
  readonly children: React.ReactNode
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "tabIndex">) => {
  return (
    <button
      type="button"
      {...button}
      {...menu.row(index)}
      className="chat-option nodrag nopan"
      data-on={menu.at === index || undefined}
    >
      <span className="chat-option-number" aria-hidden>
        {index + 1}
      </span>
      <span className="chat-option-words">{children}</span>
    </button>
  )
}

const Choices = ({
  dialog,
  refused,
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
  const menu = useMenu(dialog.options.length)
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
  const refusedWords = writing?.text === "prompt" && refused(words)
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
          {shownControls(dialog.title)}
        </p>
      )}
      {dialog.detail && (
        <pre className="chat-detail nodrag nopan nowheel" tabIndex={0} aria-label="What it asks">
          {shownControls(dialog.detail)}
        </pre>
      )}
      <div
        className="chat-options"
        role="group"
        aria-labelledby={dialog.title ? label : undefined}
        aria-label={dialog.title ? undefined : "Answers"}
        onKeyDown={menu.onKeyDown}
        onPointerMove={menu.onPointerMove}
      >
        {dialog.options.map((option, index) => (
          <Row
            key={option.id}
            menu={menu}
            index={index}
            disabled={sending}
            aria-expanded={option.text ? open === option.id : undefined}
            data-open={open === option.id || undefined}
            onClick={() => {
              edited()
              if (option.text) setOpened(open === option.id ? null : { dialog: dialog.id, option })
              else send(choiceAnswer(dialog.id, option.id))
            }}
          >
            {shownControls(option.label)}
            {option.text && "…"}
            <Sending sending={sending && menu.at === index} />
          </Row>
        ))}
      </div>
      {writing?.text && (
        <div className="chat-writing">
          <textarea
            ref={field}
            className="chat-field nodrag nopan"
            aria-label={writing.label}
            aria-describedby={
              writing.text === "field" ? `${label}-hint ${label}-line` : `${label}-hint`
            }
            placeholder={textHint[writing.text]}
            rows={1}
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
          <button
            type="button"
            className="chat-key nodrag nopan"
            disabled={sending || words.trim() === "" || blockedWords}
            onClick={submit}
          >
            Send answer
            <Sending sending={sending} />
          </button>
          {writing.text === "field" && (
            <p className="sr-only" id={`${label}-line`}>
              The agent's field takes one line.
            </p>
          )}
          <Hint
            id={`${label}-hint`}
            className="chat-field-hint"
            text={refusedWords ? promptHint : controlWords ? controlHint : ""}
          />
        </div>
      )}
    </div>
  )
}

// A question's rows: its options, marked `[✓]` where several may be picked, then the row for the
// person's own words. A mark has a cell of its own, so picking moves nothing.
const QuestionRows = ({
  question,
  id,
  pick,
  shown,
  onPick,
  onWrite,
  onDone,
}: {
  readonly question: ChatQuestion
  readonly id: string
  readonly pick: Pick | undefined
  // Whether its page is the one on screen: hidden ones keep their height, not their keys.
  readonly shown: boolean
  readonly onPick: (option: string) => void
  readonly onWrite: (text: string) => void
  // On to the next page.
  readonly onDone: () => void
}): React.JSX.Element => {
  const menu = useMenu(question.options.length + (question.text ? 1 : 0))
  return (
    <fieldset
      className="chat-question"
      role={question.multiSelect ? "group" : "radiogroup"}
      aria-labelledby={`${id}-q`}
      onKeyDown={menu.onKeyDown}
      onPointerMove={menu.onPointerMove}
    >
      <legend id={`${id}-q`} className="chat-question-text">
        {shownControls(question.question)}
      </legend>
      {question.options.map((option, at) => {
        const checked = pick?.options.includes(option.id) ?? false
        const row = menu.row(at)
        return (
          <label key={option.id} className="chat-option" data-on={menu.at === at || undefined}>
            {/* No `name`: the group is the person's marks, which React keeps, and a named group
                would answer Tab and the arrows its own way, picking as it goes. */}
            <input
              {...row}
              type={question.multiSelect ? "checkbox" : "radio"}
              className="sr-only nodrag nopan"
              tabIndex={shown ? row.tabIndex : -1}
              checked={checked}
              aria-labelledby={`${id}-${at}-l`}
              aria-describedby={option.description ? `${id}-${at}-d` : undefined}
              onChange={() => onPick(option.id)}
              onClick={() => {
                // Picked already, so nothing changes: on, all the same.
                if (checked && !question.multiSelect) onDone()
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || hasModifier(event)) return
                event.preventDefault()
                if (question.multiSelect || checked) onDone()
                else onPick(option.id)
              }}
            />
            <span className="chat-option-number" aria-hidden>
              {at + 1}
            </span>
            <span className="chat-option-words">
              {question.multiSelect && (
                <span className="chat-check" aria-hidden>
                  [<span className="chat-check-mark">{checked ? "✓" : ""}</span>]{" "}
                </span>
              )}
              <span id={`${id}-${at}-l`}>{shownControls(option.label)}</span>
            </span>
            {option.description && (
              <span className="chat-option-more" id={`${id}-${at}-d`}>
                {shownControls(option.description)}
              </span>
            )}
          </label>
        )
      })}
      {question.text && (
        <OwnWords
          question={question}
          id={id}
          text={pick?.text ?? ""}
          row={menu.row(question.options.length)}
          on={menu.at === question.options.length}
          number={question.options.length + 1}
          shown={shown}
          onWrite={onWrite}
          onDone={onDone}
        />
      )}
    </fieldset>
  )
}

const OwnWords = ({
  question,
  id,
  text,
  row,
  on,
  number,
  shown,
  onWrite,
  onDone,
}: {
  readonly question: ChatQuestion
  readonly id: string
  readonly text: string
  readonly row: ReturnType<Menu["row"]>
  readonly on: boolean
  readonly number: number
  readonly shown: boolean
  readonly onWrite: (text: string) => void
  readonly onDone: () => void
}): React.JSX.Element => (
  <>
    <label className="chat-option" data-on={on || undefined}>
      <span className="chat-option-number" aria-hidden>
        {number}
      </span>
      <input
        {...row}
        type="text"
        tabIndex={shown ? row.tabIndex : -1}
        maxLength={wordsMax}
        className="chat-field nodrag nopan"
        aria-label={`Other: ${question.question}`}
        aria-describedby={`${id}-other-hint`}
        placeholder="Something else…"
        value={text}
        autoComplete="off"
        spellCheck
        onChange={(event) => onWrite(event.target.value)}
        onKeyDown={submitOnEnter(onDone)}
      />
    </label>
    <Hint
      id={`${id}-other-hint`}
      className="chat-field-hint"
      text={hasControlCharacters(text) ? controlHint : ""}
    />
  </>
)

// What a question's answer says, for the page that sends them.
const answerWords = (question: ChatQuestion, pick: Pick | undefined): string => {
  const labels = question.options
    .filter((option) => pick?.options.includes(option.id))
    .map((option) => option.label)
  const own = question.text ? pick?.text.trim() : ""
  return [...labels, ...(own ? [`“${own}”`] : [])].join(", ")
}

const hasModifier = (event: React.KeyboardEvent): boolean =>
  event.altKey || event.ctrlKey || event.metaKey

// Focus to a page's row the person is on, or its first control.
const focusPage = (pages: HTMLElement | null, page: number): void =>
  pages
    ?.querySelector<HTMLElement>(
      `[data-page="${page}"] :is(input, button):not([tabindex="-1"], :disabled)`,
    )
    ?.focus({ preventScroll: true })

// Whether focus is free for a dialog that appears in `within`: on nothing, or in its host's area
// on what holds no words of the person's.
const askedFree = (within: Element | null, place: RequestPlace): boolean => {
  const active = document.activeElement
  if (!active || active === document.body) return true
  if (!within || !place.area(within)?.contains(active)) return false
  return !holdsWords(active)
}

const headerOf = (question: ChatQuestion, index: number): string =>
  question.header ?? `Question ${index + 1}`

// The page that sends the answers: what they are, then the two rows.
const Review = ({
  questions,
  picks,
  ready,
  held,
  hintId,
  sending,
  shown,
  onRestart,
}: {
  readonly questions: readonly ChatQuestion[]
  readonly picks: Picks
  readonly ready: boolean
  // Whether the person's own words hold what can't go.
  readonly held: boolean
  readonly hintId: string
  readonly sending: boolean
  readonly shown: boolean
  readonly onRestart: () => void
}): React.JSX.Element => {
  const menu = useMenu(2)
  const row = (index: number) => {
    const taken = menu.row(index)
    return {
      ...taken,
      tabIndex: shown ? taken.tabIndex : -1,
      "data-on": menu.at === index || undefined,
    }
  }
  return (
    <>
      <p className="chat-question-text">Send these answers?</p>
      <dl className="chat-review">
        {questions.map((question, index) => {
          const words = answerWords(question, picks[question.id])
          return (
            <div key={question.id}>
              <dt>{shownControls(headerOf(question, index))}</dt>
              <dd data-empty={words === "" || undefined}>
                {words === "" ? "not answered" : shownControls(words)}
              </dd>
            </div>
          )
        })}
      </dl>
      {/* The hint by the words themselves is on a page out of sight. */}
      <Hint
        id={hintId}
        className="chat-field-hint chat-review-hint"
        text={held ? controlHint : ""}
      />
      <div
        className="chat-options"
        role="group"
        aria-label="Send the answers"
        onKeyDown={menu.onKeyDown}
        onPointerMove={menu.onPointerMove}
      >
        <button
          {...row(0)}
          type="submit"
          className="chat-option nodrag nopan"
          aria-disabled={!ready || undefined}
          aria-describedby={held ? hintId : undefined}
        >
          <span className="chat-option-number" aria-hidden>
            1
          </span>
          <span className="chat-option-words">
            Submit answers
            <Sending sending={sending} />
          </span>
        </button>
        <button {...row(1)} type="button" className="chat-option nodrag nopan" onClick={onRestart}>
          <span className="chat-option-number" aria-hidden>
            2
          </span>
          <span className="chat-option-words">Start over</span>
        </button>
      </div>
    </>
  )
}

const Questions = ({
  dialog,
  place,
  sending,
  send,
  edited,
  replying,
  onReply,
}: Controls & {
  readonly dialog: Extract<ChatDialog, { type: "questions" }>
  readonly place: RequestPlace
  // The host's box answers this dialog: its words are said to the agent in place of answers.
  readonly replying: boolean
  readonly onReply: ((dialog: string | null) => void) | undefined
}): React.JSX.Element => {
  const [chosen, setPicks] = useState<Picks>({})
  // The page on screen: a question's, or past them the one that sends the answers.
  const [turned, setTurned] = useState(0)
  const base = useId()
  const pages = useRef<HTMLFieldSetElement>(null)
  const { questions } = dialog
  const page = Math.min(turned, questions.length)
  // A re-read dialog may have lost options the person had picked; their words stay.
  const picks = reconcile(chosen, questions)
  const ready = complete(picks, questions) && !holdsControls(picks, questions)
  const submit = (): void => {
    if (ready && !sending && !replying) send(questionsAnswer(dialog.id, picks, questions))
  }
  // The questions take the keys as they appear, as a harness's own do, unless the person is
  // writing something or is elsewhere: then what they type stays where they type it. Where the
  // card sits is the host's at the time.
  const now = useRef({ page, held: replying || sending, place })
  useEffect(() => {
    now.current = { page, held: replying || sending, place }
  })
  // The keys go on with the page.
  const moved = useRef(false)
  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    focusPage(pages.current, page)
    // The pages share a cell as tall as the tallest: this one starts at its top.
    const scroller = pages.current && now.current.place.scroller(pages.current)
    if (scroller) scroller.scrollTop = 0
  }, [page])
  useEffect(() => {
    // A dialog read again leaves the person where they are in it.
    const form = pages.current?.closest("form")
    if (now.current.held || form?.contains(document.activeElement)) return
    if (askedFree(pages.current, now.current.place)) focusPage(pages.current, now.current.page)
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Only as the dialog comes.
  }, [dialog.id])
  const turnTo = (to: number): void => {
    moved.current = true
    setTurned(to)
  }
  // Talking it over: where the words go on as a prompt, the dialog goes at once and the
  // host's box takes them; where the agent's field takes them, the box answers with them.
  const talks = dialog.chat === "prompt" || (dialog.chat !== null && onReply !== undefined)
  const chat = (): void => {
    edited()
    if (dialog.chat === "prompt") send(chatAnswer(dialog.id, ""))
    else onReply?.(replying ? null : dialog.id)
  }
  const tabId = (at: number): string => `${base}-tab-${at}`
  const panelId = (at: number): string => `${base}-page-${at}`
  // Left and right turn the pages from anywhere in them, as a harness's tabs do.
  const turnKeys = (event: React.KeyboardEvent): void => {
    // Down from a tab goes into its page.
    const onTab = event.target instanceof Element && event.target.closest('[role="tab"]') !== null
    if (event.key === "ArrowDown" && onTab && !hasModifier(event)) {
      event.preventDefault()
      focusPage(pages.current, page)
      return
    }
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return
    if (replying || hasModifier(event) || isTyping(event.target)) return
    event.preventDefault()
    const count = questions.length + 1
    const to = (page + (event.key === "ArrowRight" ? 1 : count - 1)) % count
    if (onTab) {
      setTurned(to)
      document.getElementById(tabId(to))?.focus()
    } else turnTo(to)
  }
  return (
    <form
      className="chat-dialog chat-questions"
      aria-label="Answer the questions"
      onKeyDown={turnKeys}
      onKeyDownCapture={(event) => {
        // Enter goes on a page at a time: held, it would answer the rest and send them.
        if (event.key !== "Enter" || !event.repeat) return
        event.preventDefault()
        event.stopPropagation()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        if (page < questions.length) turnTo(page + 1)
        else submit()
      }}
    >
      <div className="chat-tabs-line">
        {replying ? (
          <p className="chat-dialog-title">
            The questions are set aside. Your reply in the box below goes to the agent instead.
          </p>
        ) : (
          <div className="chat-tabs" role="tablist" aria-label="The questions">
            {[
              ...questions.map((question, index) => ({
                key: `question:${question.id}`,
                name: headerOf(question, index),
              })),
              { key: "submit", name: "Submit" },
            ].map(({ key, name }, at) => (
              <button
                key={key}
                id={tabId(at)}
                type="button"
                role="tab"
                className="chat-tab nodrag nopan"
                aria-selected={at === page}
                aria-controls={panelId(at)}
                tabIndex={at === page ? 0 : -1}
                disabled={sending}
                onClick={() => setTurned(at)}
              >
                {at < questions.length && answered(picks, questions[at]!) && (
                  <span className="chat-tab-done" aria-hidden>
                    ✓
                  </span>
                )}
                {shownControls(name)}
              </button>
            ))}
          </div>
        )}
        {talks && (
          <button type="button" className="chat-key nodrag nopan" disabled={sending} onClick={chat}>
            {replying ? "Back to the questions" : "Chat about this"}
          </button>
        )}
      </div>
      {!replying && questions.length > 1 && (
        <span className="sr-only" role="status">
          {answeredCount(picks, questions)} of {questions.length} answered
        </span>
      )}
      {!replying && (
        // Every page in one cell, so the tallest sets the height and turning one moves nothing.
        <fieldset ref={pages} className="chat-pages" disabled={sending}>
          {questions.map((question, index) => {
            const id = `${base}-${index}`
            return (
              <div
                key={question.id}
                id={panelId(index)}
                role="tabpanel"
                className="chat-page"
                aria-labelledby={tabId(index)}
                data-page={index}
                data-shown={index === page || undefined}
              >
                <QuestionRows
                  question={question}
                  id={id}
                  pick={picks[question.id]}
                  shown={index === page}
                  onPick={(option) => {
                    setPicks(choose(picks, question, option))
                    edited()
                    if (!question.multiSelect) turnTo(index + 1)
                  }}
                  onWrite={(text) => {
                    setPicks(write(picks, question, text))
                    edited()
                  }}
                  onDone={() => turnTo(index + 1)}
                />
              </div>
            )
          })}
          <div
            id={panelId(questions.length)}
            role="tabpanel"
            className="chat-page"
            aria-labelledby={tabId(questions.length)}
            data-page={questions.length}
            data-shown={page === questions.length || undefined}
          >
            <Review
              questions={questions}
              picks={picks}
              ready={ready}
              held={holdsControls(picks, questions)}
              hintId={`${base}-held`}
              sending={sending}
              shown={page === questions.length}
              onRestart={() => {
                setPicks({})
                turnTo(0)
                edited()
              }}
            />
          </div>
        </fieldset>
      )}
    </form>
  )
}

// A set to pick one of, as words on a line: the one picked underlined. Picking it again takes it
// back, for a field the person would rather leave unsaid.
const Picked = ({
  field,
  labelId,
  described,
  name,
  value,
  invalid,
  onChange,
}: {
  readonly field: ChatFormField
  readonly labelId: string
  readonly described: string | undefined
  readonly name: string
  readonly value: string
  readonly invalid: boolean
  readonly onChange: (value: string) => void
}): React.JSX.Element => (
  <div
    className="chat-picks"
    role="radiogroup"
    aria-labelledby={labelId}
    aria-required={field.required || undefined}
    aria-invalid={invalid || undefined}
    aria-describedby={described}
  >
    {(field.kind === "boolean" ? ["yes", "no"] : field.choices).map((choice) => (
      <label key={choice} className="chat-pick" data-on={value === choice || undefined}>
        <input
          type="radio"
          name={name}
          className="sr-only nodrag nopan"
          checked={value === choice}
          onChange={() => onChange(choice)}
          onClick={() => {
            if (value === choice) onChange("")
          }}
          onKeyDown={(event) => {
            // Space on a picked radio does nothing of itself. Held, it would pick again.
            if (event.key !== " " || (value !== choice && !event.repeat)) return
            event.preventDefault()
            if (value === choice) onChange("")
          }}
        />
        {field.kind === "boolean" ? (choice === "yes" ? "Yes" : "No") : choice}
      </label>
    ))}
  </div>
)

const Form = ({
  dialog,
  sending,
  send,
  edited,
}: Controls & { readonly dialog: Extract<ChatDialog, { type: "form" }> }): React.JSX.Element => {
  const [typed, setEntries] = useState<Entries>({})
  // The person tried to submit: what is missing says so.
  const [tried, setTried] = useState(false)
  const base = useId()
  const menu = useMenu(2)
  const { fields } = dialog
  // A form read again keeps what was entered in the fields that are still there.
  const entries = keptEntries(typed, fields)
  const ready = formComplete(entries, fields)
  const change = (field: ChatFormField, value: string): void => {
    setEntries(enter(entries, field, value))
    edited()
  }
  const answer = (action: "accept" | "decline"): void => {
    if (sending) return
    if (action === "accept" && !ready) {
      setTried(true)
      return
    }
    send(formAnswer(dialog.id, action, entries, fields))
  }
  return (
    <form
      className="chat-dialog chat-form"
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
          const invalid = !entryValid(entries, field)
          const mark = field.required && (
            <span aria-hidden className="chat-required">
              {" *"}
            </span>
          )
          return (
            <div
              key={field.id}
              className="chat-form-field"
              data-missing={(invalid && (tried || entry.value !== "")) || undefined}
            >
              {field.kind === "choice" || field.kind === "boolean" ? (
                <span className="chat-form-label" id={`${id}-l`}>
                  {field.label}
                  {mark}
                </span>
              ) : (
                <label className="chat-form-label" htmlFor={id}>
                  {field.label}
                  {mark}
                </label>
              )}
              {field.kind === "choice" || field.kind === "boolean" ? (
                <Picked
                  field={field}
                  labelId={`${id}-l`}
                  described={described}
                  name={id}
                  value={entry.value}
                  invalid={invalid && tried}
                  onChange={(value) => change(field, value)}
                />
              ) : (
                <input
                  id={id}
                  type={field.kind === "number" ? "number" : "text"}
                  maxLength={field.kind === "text" ? formTextMax : undefined}
                  step={field.kind === "number" ? "any" : undefined}
                  className="chat-field nodrag nopan"
                  placeholder={field.required ? "required" : "optional"}
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
                <p className="chat-form-description" id={`${id}-d`}>
                  {field.description}
                </p>
              )}
            </div>
          )
        })}
      </fieldset>
      <div
        className="chat-options"
        role="group"
        aria-label="Answer the form"
        onKeyDown={menu.onKeyDown}
        onPointerMove={menu.onPointerMove}
      >
        <button
          {...menu.row(0)}
          type="submit"
          className="chat-option nodrag nopan"
          data-on={menu.at === 0 || undefined}
          aria-disabled={!ready || sending || undefined}
        >
          <span className="chat-option-number" aria-hidden>
            1
          </span>
          <span className="chat-option-words">
            Submit
            <Sending sending={sending} />
          </span>
        </button>
        <Row menu={menu} index={1} disabled={sending} onClick={() => answer("decline")}>
          Decline
        </Row>
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
  live,
}: {
  readonly dialog: Extract<ChatDialog, { type: "raw" }>
  readonly live: Live | undefined
}): React.JSX.Element => (
  <div className="chat-dialog">
    {/* That an answer didn't take is news; why the chat can't read a dialog isn't, with the
        dialog's own rows right there. */}
    <p
      className={
        dialog.reason === "failed" || !live ? "chat-raw-reason" : "chat-raw-reason sr-only"
      }
      data-failed={dialog.reason === "failed" || undefined}
    >
      {reasons[dialog.reason]}
    </p>
    {live ? (
      live.rows
    ) : (
      <pre className="chat-raw nodrag nopan nowheel" tabIndex={0} aria-label="The dialog's text">
        {shownControls(dialog.text)}
      </pre>
    )}
  </div>
)

// The dialog's controls: a menu for choices, tabbed pages for questions, a line per field for a
// form, the terminal's own rows or the dialog's text for one the chat can't answer.
export const RequestDialog = ({
  dialog,
  live,
  place,
  replying,
  onReply,
  ...controls
}: Controls & {
  readonly dialog: ChatDialog
  // The terminal's own rows, shown for a dialog no adapter read in place of its text.
  readonly live: Live | undefined
  readonly place: RequestPlace
  readonly replying: boolean
  readonly onReply: ((dialog: string | null) => void) | undefined
}): React.JSX.Element =>
  dialog.type === "choices" ? (
    <Choices dialog={dialog} {...controls} />
  ) : dialog.type === "questions" ? (
    <Questions dialog={dialog} place={place} replying={replying} onReply={onReply} {...controls} />
  ) : dialog.type === "form" ? (
    <Form dialog={dialog} {...controls} />
  ) : (
    <Raw dialog={dialog} live={live} />
  )
