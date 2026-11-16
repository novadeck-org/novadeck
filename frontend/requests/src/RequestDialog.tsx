import type {
  ChatAnswer,
  ChatDialog,
  ChatFormField,
  ChatQuestion,
  ChatRequest,
} from "@novadeck/core/conversation"
import { fieldRefusal, noExtras, optionExtras } from "@novadeck/core/conversation/extras"
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
import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react"

import { Detail } from "./Detail"
import { useDraft, type Drafted } from "./drafts"
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
import { answerWordsLimit, Menu as OptionMenu, type MenuHandle, type MenuItem } from "./Menu"
import { shownControls } from "./shown-controls"
import { submitOnEnter } from "./submit-on-enter"
import {
  answersKey,
  forwardKey,
  goToRow,
  holdsWords,
  isTyping,
  movesKey,
  useArrivalGuard,
  useMenu,
  type Menu,
} from "./use-menu"

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
  // Where the host keeps what the person put in and hasn't sent; absent, the dialog keeps it.
  readonly draft: Drafted | undefined
  // The host moved on to this dialog from an answer: for a moment no key or click answers it.
  readonly arrived: boolean
  // A handle on the menu the person is on, for keys the host takes on its own row or title.
  readonly handle: Ref<MenuHandle> | undefined
  readonly place: RequestPlace
}

// The host's own sides of a dialog, each optional.
export type DialogSlots = {
  // In place of what a choices dialog asks in full: the host's own box of it, as the Inbox's plan.
  readonly detail?: ReactNode
  // The agent's harness, by its own name (`Conversation.agent`), for what its fields refuse.
  readonly harness?: string | null | undefined
}

const Sending = ({ sending }: { readonly sending: boolean }): React.JSX.Element | null =>
  sending ? (
    <span className="request-sending" aria-hidden>
      {" "}
      …
    </span>
  ) : null

// What the protocol takes: the person's words, and a form's text value.
const wordsMax = answerWordsLimit
const formTextMax = 4096

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
      className="request-option nodrag nopan"
      data-on={menu.at === index || undefined}
    >
      <span className="request-option-number" aria-hidden>
        {index + 1}
      </span>
      <span className="request-option-words">{children}</span>
    </button>
  )
}

// A dialog's options, in the harness's own words, with what core reads into them: a standing
// yes's scope on a line under it, what a plan's standing yes lets the agent do, and an option
// that is hard to take back armed before it sends. An option that takes words is a field the
// person types into in its place.
const Choices = ({
  dialog,
  kind,
  refused,
  sending,
  send,
  edited,
  draft,
  arrived,
  handle,
  place,
  detail,
  harness,
}: Controls &
  DialogSlots & {
    readonly dialog: Extract<ChatDialog, { type: "choices" }>
    readonly kind: ChatRequest["kind"]
  }): React.JSX.Element => {
  // The words typed into each option that takes them, by its id: a dialog read again keeps them.
  const kept = useDraft(draft)
  const typed = kept.get("typed") ?? {}
  const [pressed, setPressed] = useState<number | null>(null)
  const label = useId()
  const extras = optionExtras(kind, dialog.options)
  const items = dialog.options.map((option, index): MenuItem => {
    const extra = extras[index] ?? noExtras
    const words = typed[option.id] ?? ""
    // Words that go on as the agent's next prompt are checked, not those typed in its field.
    const blocked =
      option.text === "prompt" && refused(words)
        ? promptHint
        : option.text === "field" && hasControlCharacters(words)
          ? controlHint
          : option.text === "field" && words !== ""
            ? fieldRefusal(harness ?? null, words)
            : null
    return {
      // A row that means something else, read again, is another row.
      key: `${option.id}\n${option.label}\n${option.text ?? ""}`,
      label: shownControls(extra.lines?.head ?? option.label),
      scope: extra.lines && shownControls(extra.lines.scope),
      effect: extra.effect,
      arms: extra.hard,
      ...(option.text && {
        words: {
          value: words,
          onChange: (text) => {
            const value = option.text === "field" ? oneLine(text) : text
            kept.update("typed", (all) => ({ ...all, [option.id]: value }))
            edited()
          },
          // The row is the field: the harness's words say what to write, and name it.
          placeholder: shownControls(option.label),
          field: option.label,
          required: true,
          refused: blocked,
          hint: "send",
          limit: answerWordsLimit,
          oneLine: option.text === "field",
        },
      }),
    }
  })
  return (
    <div className="request-dialog">
      {dialog.title && (
        <p className="request-dialog-title" id={label}>
          {shownControls(dialog.title)}
        </p>
      )}
      {detail ?? (dialog.detail && <Detail text={dialog.detail} label="What it asks" />)}
      <OptionMenu
        label={dialog.title ? shownControls(dialog.title) : "Answers"}
        items={items}
        busy={sending}
        pressed={pressed}
        handle={handle}
        arrived={arrived}
        area={place.area}
        onPress={(index) => {
          const option = dialog.options[index]
          if (!option) return
          edited()
          setPressed(index)
          send(choiceAnswer(dialog.id, option.id))
        }}
        onOpen={edited}
        onWords={(index) => {
          const option = dialog.options[index]
          if (!option) return
          setPressed(index)
          send(choiceAnswer(dialog.id, option.id, typed[option.id] ?? ""))
        }}
      />
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
      className="request-question"
      role={question.multiSelect ? "group" : "radiogroup"}
      aria-labelledby={`${id}-q`}
      onKeyDown={menu.onKeyDown}
      onPointerMove={menu.onPointerMove}
    >
      <legend id={`${id}-q`} className="request-question-text">
        {shownControls(question.question)}
      </legend>
      {question.options.map((option, at) => {
        const checked = pick?.options.includes(option.id) ?? false
        const row = menu.row(at)
        return (
          <label key={option.id} className="request-option" data-on={menu.at === at || undefined}>
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
            <span className="request-option-number" aria-hidden>
              {at + 1}
            </span>
            <span className="request-option-words">
              {question.multiSelect && (
                <span className="request-check" aria-hidden>
                  [<span className="request-check-mark">{checked ? "✓" : ""}</span>]{" "}
                </span>
              )}
              <span id={`${id}-${at}-l`}>{shownControls(option.label)}</span>
            </span>
            {option.description && (
              <span className="request-option-more" id={`${id}-${at}-d`}>
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
    <label className="request-option" data-on={on || undefined}>
      <span className="request-option-number" aria-hidden>
        {number}
      </span>
      <input
        {...row}
        type="text"
        tabIndex={shown ? row.tabIndex : -1}
        maxLength={wordsMax}
        className="request-field nodrag nopan"
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
      className="request-field-hint"
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
      <p className="request-question-text">Send these answers?</p>
      <dl className="request-review">
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
        className="request-field-hint request-review-hint"
        text={held ? controlHint : ""}
      />
      <div
        className="request-options"
        role="group"
        aria-label="Send the answers"
        onKeyDown={menu.onKeyDown}
        onPointerMove={menu.onPointerMove}
      >
        <button
          {...row(0)}
          type="submit"
          className="request-option nodrag nopan"
          aria-disabled={!ready || undefined}
          aria-describedby={held ? hintId : undefined}
        >
          <span className="request-option-number" aria-hidden>
            1
          </span>
          <span className="request-option-words">
            Submit answers
            <Sending sending={sending} />
          </span>
        </button>
        <button
          {...row(1)}
          type="button"
          className="request-option nodrag nopan"
          onClick={onRestart}
        >
          <span className="request-option-number" aria-hidden>
            2
          </span>
          <span className="request-option-words">Start over</span>
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
  draft,
  arrived,
  handle,
  replying,
  onReply,
}: Controls & {
  readonly dialog: Extract<ChatDialog, { type: "questions" }>
  // The host's box answers this dialog: its words are said to the agent in place of answers.
  readonly replying: boolean
  readonly onReply: ((dialog: string | null) => void) | undefined
}): React.JSX.Element => {
  const kept = useDraft(draft)
  const chosen: Picks = kept.get("picks") ?? {}
  const setPicks = (next: Picks): void => kept.set("picks", next)
  // The page on screen: a question's, or past them the one that sends the answers.
  const turned = kept.get("page") ?? 0
  const setTurned = (to: number): void => kept.set("page", to)
  const base = useId()
  const pages = useRef<HTMLFieldSetElement>(null)
  const guard = useArrivalGuard(arrived)
  // The page on screen's rows take the keys the host passes on.
  const shownPage = (): Element | null | undefined =>
    pages.current?.querySelector("[data-page][data-shown]")
  useImperativeHandle(handle, () => ({
    key: (key) => (guard.keysHeld() && answersKey(key) ? true : forwardKey(shownPage(), key)),
    go: (at) => goToRow(shownPage(), at),
    focus: (arming) => {
      if (arming) guard.holdKeys()
      focusPage(pages.current, Math.min(turned, dialog.questions.length))
      return Boolean(shownPage()?.contains(document.activeElement))
    },
  }))
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
    // oxlint-disable-next-line react/immutability -- The host's scroller, not React's state.
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
      className="request-dialog request-questions"
      aria-label="Answer the questions"
      onKeyDown={turnKeys}
      onPointerDownCapture={guard.release}
      onKeyDownCapture={(event) => {
        if (movesKey(event.key)) guard.release()
        // Enter goes on a page at a time: held, it would answer the rest and send them. As the
        // host moves on to it, no key answers for a moment, but words typed in a field go in.
        const held = event.key === "Enter" && event.repeat
        const arriving = guard.keysHeld() && answersKey(event.key) && !isTyping(event.target)
        if (!held && !arriving) return
        event.preventDefault()
        event.stopPropagation()
      }}
      onClickCapture={(event) => {
        // A double-click's second click, landing as the host moves on, isn't for this.
        if (!guard.on()) return
        event.preventDefault()
        event.stopPropagation()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        if (page < questions.length) turnTo(page + 1)
        else submit()
      }}
    >
      <div className="request-tabs-line">
        {replying ? (
          <p className="request-dialog-title">
            The questions are set aside. Your reply in the box below goes to the agent instead.
          </p>
        ) : (
          <div className="request-tabs" role="tablist" aria-label="The questions">
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
                className="request-tab nodrag nopan"
                aria-selected={at === page}
                aria-controls={panelId(at)}
                tabIndex={at === page ? 0 : -1}
                disabled={sending}
                onClick={() => setTurned(at)}
              >
                {at < questions.length && answered(picks, questions[at]!) && (
                  <span className="request-tab-done" aria-hidden>
                    ✓
                  </span>
                )}
                {shownControls(name)}
              </button>
            ))}
          </div>
        )}
        {talks && (
          <button
            type="button"
            className="request-key nodrag nopan"
            disabled={sending}
            onClick={chat}
          >
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
        <fieldset ref={pages} className="request-pages" disabled={sending}>
          {questions.map((question, index) => {
            const id = `${base}-${index}`
            return (
              <div
                key={question.id}
                id={panelId(index)}
                role="tabpanel"
                className="request-page"
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
            className="request-page"
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
    className="request-picks"
    role="radiogroup"
    aria-labelledby={labelId}
    aria-required={field.required || undefined}
    aria-invalid={invalid || undefined}
    aria-describedby={described}
  >
    {(field.kind === "boolean" ? ["yes", "no"] : field.choices).map((choice) => (
      <label key={choice} className="request-pick" data-on={value === choice || undefined}>
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
  draft,
  arrived,
  handle,
  place,
}: Controls & { readonly dialog: Extract<ChatDialog, { type: "form" }> }): React.JSX.Element => {
  const kept = useDraft(draft)
  const typed: Entries = kept.get("entries") ?? {}
  const setEntries = (next: Entries): void => kept.set("entries", next)
  // The person tried to submit: what is missing says so.
  const [tried, setTried] = useState(false)
  const base = useId()
  const menu = useMenu(2)
  const root = useRef<HTMLFormElement>(null)
  const guard = useArrivalGuard(arrived)
  const options = (): Element | null | undefined => root.current?.querySelector(".request-options")
  useImperativeHandle(handle, () => ({
    key: (key) => (guard.keysHeld() && answersKey(key) ? true : forwardKey(options(), key)),
    go: (at) => goToRow(options(), at),
    // Its first field, as moving on to it does, or its rows where it has none.
    focus: (arming) => {
      const form = root.current
      const to =
        form?.querySelector<HTMLElement>("input:not([tabindex='-1'])") ??
        options()?.querySelector<HTMLElement>("[tabindex='0']")
      if (!to) return false
      if (arming) guard.holdKeys()
      to.focus({ preventScroll: true })
      return document.activeElement === to
    },
  }))
  // Moved on to from an answer, the keyboard comes to its first field, as a menu's first row.
  const placeNow = useRef(place)
  useEffect(() => {
    placeNow.current = place
  })
  useEffect(() => {
    const form = root.current
    if (!arrived || !form) return
    const active = document.activeElement
    const before = placeNow.current.area(form)
    if (!active || active === document.body || (before?.contains(active) && !holdsWords(active)))
      form.querySelector<HTMLElement>("input:not([tabindex='-1'])")?.focus({ preventScroll: true })
  }, [arrived])
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
      ref={root}
      className="request-dialog request-form"
      aria-label="Fill in the form"
      noValidate
      onPointerDownCapture={guard.release}
      onKeyDownCapture={(event) => {
        if (movesKey(event.key)) guard.release()
        // As the host moves on to it, no key answers for a moment, but words typed go in; Enter
        // in a field submits nothing meanwhile (`onSubmit`).
        if (!guard.keysHeld() || !answersKey(event.key) || isTyping(event.target)) return
        event.preventDefault()
        event.stopPropagation()
      }}
      onClickCapture={(event) => {
        if (!guard.on()) return
        event.preventDefault()
        event.stopPropagation()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        if (guard.keysHeld()) return
        answer("accept")
      }}
    >
      {dialog.message && <p className="request-dialog-title">{dialog.message}</p>}
      <fieldset className="request-form-fields" disabled={sending}>
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
            <span aria-hidden className="request-required">
              {" *"}
            </span>
          )
          return (
            <div
              key={field.id}
              className="request-form-field"
              data-missing={(invalid && (tried || entry.value !== "")) || undefined}
            >
              {field.kind === "choice" || field.kind === "boolean" ? (
                <span className="request-form-label" id={`${id}-l`}>
                  {field.label}
                  {mark}
                </span>
              ) : (
                <label className="request-form-label" htmlFor={id}>
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
                  className="request-field nodrag nopan"
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
                  className="request-field-hint"
                  text={hasControlCharacters(entry.value) ? controlHint : ""}
                />
              )}
              {field.description && (
                <p className="request-form-description" id={`${id}-d`}>
                  {field.description}
                </p>
              )}
            </div>
          )
        })}
      </fieldset>
      <div
        className="request-options"
        role="group"
        aria-label="Answer the form"
        onKeyDown={menu.onKeyDown}
        onPointerMove={menu.onPointerMove}
      >
        <button
          {...menu.row(0)}
          type="submit"
          className="request-option nodrag nopan"
          data-on={menu.at === 0 || undefined}
          aria-disabled={!ready || sending || undefined}
        >
          <span className="request-option-number" aria-hidden>
            1
          </span>
          <span className="request-option-words">
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
  unsupported: "Novadeck can't answer this dialog. Answer it in the terminal.",
  failed: "That answer didn't take.",
} as const

const Raw = ({
  dialog,
  live,
}: {
  readonly dialog: Extract<ChatDialog, { type: "raw" }>
  readonly live: Live | undefined
}): React.JSX.Element => (
  <div className="request-dialog">
    {/* That an answer didn't take is news; why the chat can't read a dialog isn't, with the
        dialog's own rows right there. */}
    <p
      className={
        dialog.reason === "failed" || !live ? "request-raw-reason" : "request-raw-reason sr-only"
      }
      data-failed={dialog.reason === "failed" || undefined}
    >
      {reasons[dialog.reason]}
    </p>
    {live ? (
      live.rows
    ) : (
      <pre className="request-raw nodrag nopan nowheel" tabIndex={0} aria-label="The dialog's text">
        {shownControls(dialog.text)}
      </pre>
    )}
  </div>
)

// The dialog's controls: a menu for choices, tabbed pages for questions, a line per field for a
// form, the terminal's own rows or the dialog's text for one the chat can't answer.
export const RequestDialog = ({
  dialog,
  kind,
  live,
  replying,
  onReply,
  detail,
  harness,
  ...controls
}: Controls &
  DialogSlots & {
    readonly dialog: ChatDialog
    readonly kind: ChatRequest["kind"]
    // The terminal's own rows, shown for a dialog no adapter read in place of its text.
    readonly live: Live | undefined
    readonly replying: boolean
    readonly onReply: ((dialog: string | null) => void) | undefined
  }): React.JSX.Element =>
  dialog.type === "choices" ? (
    <Choices dialog={dialog} kind={kind} detail={detail} harness={harness} {...controls} />
  ) : dialog.type === "questions" ? (
    <Questions dialog={dialog} replying={replying} onReply={onReply} {...controls} />
  ) : dialog.type === "form" ? (
    <Form dialog={dialog} {...controls} />
  ) : (
    <Raw dialog={dialog} live={live} />
  )
