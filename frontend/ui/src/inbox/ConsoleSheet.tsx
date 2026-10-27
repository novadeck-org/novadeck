/* oxlint-disable react/no-array-index-key -- Lines are read from text and transcripts that have no ids; they never reorder. */
import {
  answered,
  choose,
  complete,
  questionsAnswer,
  write,
  type Picks,
} from "@novadeck/core/answers"
import type { ChatQuestion } from "@novadeck/core/conversation"
import type { HeldMessage, InboxRow, Trouble } from "@novadeck/core/inbox"
import { unsaidWaits, waitsText } from "@novadeck/core/messages"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { Markdown } from "@novadeck/toolkit/Markdown"
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"

import { useAgentContext, type AgentStep } from "./agent-context"
import { menuOf, resetLabel, type Menu as MenuModel, type Row } from "./console-menu"
import { rowOf } from "./inbox-dom"
import { actionOf, agentName, limitWindow, recommended, subjectOf } from "./inbox-text"
import { noDraft, useInboxContext } from "./InboxProvider"
import { Menu, type MenuHandle, type MenuItem } from "./Menu"
import type { SheetContentProps } from "./Page"
import { usePlanText } from "./plan-text"
import { CommandBox, Disclosure, Failure, Text } from "./sheet-parts"

// The Console sheet: one layout for every kind. The person's last words to the agent and the
// few steps it took since; the thing it asks about, word for word; and a numbered menu that
// answers it. Nothing here says what the head or the row says already.

// Your last words, or a lead's, and up to three steps that edited, ran or failed. Nothing
// while it loads, or where there is no transcript.
const Context = ({ item }: { readonly item: InboxRow }): React.JSX.Element | null => {
  const context = useAgentContext(item)
  if (!context || (!context.said && context.steps.length === 0)) return null
  const { said, steps } = context
  return (
    <div className="console-tail">
      {said && (
        <div className="console-you">
          <span className="console-gut" aria-hidden="true">
            ›
          </span>
          <span className="console-line" title={said.text}>
            {said.by && (
              <>
                <HandleChip handle={said.by} /> said{" "}
              </>
            )}
            <q>{said.text}</q>
          </span>
        </div>
      )}
      {steps.map((step, index) => (
        <Step key={index} step={step} />
      ))}
    </div>
  )
}

// "+4 −2" with its added and removed counts in their colours.
const Result = ({ step }: { readonly step: AgentStep }): React.JSX.Element | null => {
  const { result } = step
  if (!result) return null
  const parts = step.kind === "edit" ? result.split(/(\+\d+|[−-]\d+)/) : [result]
  return (
    <span className="console-res" data-kind={step.kind}>
      {parts.map((part, index) =>
        /^\+\d+$/.test(part) ? (
          <span key={index} className="console-add">
            {part}
          </span>
        ) : /^[−-]\d+$/.test(part) ? (
          <span key={index} className="console-del">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </span>
  )
}

const Step = ({ step }: { readonly step: AgentStep }): React.JSX.Element => (
  <div className="console-step" data-kind={step.kind}>
    <span className="console-gut" aria-hidden="true">
      {step.kind === "fail" ? "✗" : "●"}
    </span>
    <span className="console-line" title={step.arg}>
      <b>{step.tool}</b> <span className="console-arg">{step.arg}</span>
      <Result step={step} />
    </span>
  </div>
)

// A question or a statement, set in the sheet's sans, with its glyph in the gutter.
const Heading = ({
  glyph = "?",
  children,
}: {
  readonly glyph?: string
  readonly children: ReactNode
}): React.JSX.Element => (
  <h3 className="console-ask">
    <span className="console-q" aria-hidden="true">
      {glyph}
    </span>
    <span>{children}</span>
  </h3>
)

const Prose = ({ text }: { readonly text: string }): React.JSX.Element | null =>
  text.trim() === "" ? null : (
    <div className="console-body">
      <Markdown text={text} />
    </div>
  )

// The plan in a box of its own, as the chat draws Markdown: only the box scrolls. Until its
// text has come, or where there is none, the dialog's own words stand in.
const PlanBox = ({ item, fallback }: { readonly item: InboxRow; readonly fallback: string }) => {
  const plan = usePlanText(item)
  const text = plan ?? fallback
  const lines = text.split("\n").length
  return (
    <div className="console-planbox">
      <div className="console-planbar">
        <span>plan</span>
        <span>{lines === 1 ? "1 line" : `${lines} lines`}</span>
      </div>
      <div className="console-planscroll" tabIndex={0} aria-label="The plan">
        <Markdown text={text} />
      </div>
    </div>
  )
}

const Held = ({ held }: { readonly held: HeldMessage }): React.JSX.Element => (
  <>
    <div className="console-route">
      <HandleChip handle={held.from.handle} /> {held.from.title}
      <span aria-hidden="true"> → </span>
      <HandleChip handle={held.to.handle} /> {held.to.title}
    </div>
    <blockquote className="console-quote">{held.text}</blockquote>
    <p className="console-note">
      {held.heldFor === "loop" ? (
        <>
          <HandleChip handle={held.from.handle} /> and <HandleChip handle={held.to.handle} /> kept
          messaging while neither did any work, so Novadeck holds their thread.
        </>
      ) : (
        "Novadeck holds this thread for you."
      )}
    </p>
  </>
)

const TroubleThing = ({
  item,
  trouble,
  now,
}: {
  readonly item: InboxRow
  readonly trouble: Trouble
  readonly now: number
}): React.JSX.Element => {
  const agent = agentName(item.source.agent)
  switch (trouble.type) {
    case "failed":
      return trouble.error ? (
        <pre className="console-box" data-tone="urgent" tabIndex={0} aria-label="The error">
          {trouble.error}
        </pre>
      ) : (
        <p className="console-note">{agent} ended its turn on an error and gave no reason.</p>
      )
    case "limit":
      return (
        <p className="console-body">
          {agent} used up its {limitWindow(trouble.minutes)} window, which{" "}
          {resetLabel(trouble.resetsAt, now)}.{" "}
          {trouble.autoResume
            ? "Novadeck continues it then."
            : trouble.resetsAt <= now
              ? "It stays stopped until you continue it."
              : "It stays stopped until you continue it, from here once it resets."}
        </p>
      )
    case "stuck":
      return (
        <>
          <p className="console-body">
            <Text text={trouble.summary} />
          </p>
          <div className="console-box" aria-label={`What @${item.source.handle} ran`}>
            {trouble.evidence.map((line, index) => (
              <div className="console-evidence" key={index}>
                <span>
                  {line.text}
                  {line.result && <span className="console-res"> └ {line.result}</span>}
                </span>
                {line.times > 1 && <span className="console-times">×{line.times}</span>}
              </div>
            ))}
          </div>
        </>
      )
    case "waits":
      return (
        <p className="console-body">
          {trouble.waits ? waitsText[trouble.waits] : unsaidWaits.text}
        </p>
      )
  }
}

// What the item is about, word for word.
const Thing = ({ item, now }: { readonly item: InboxRow; readonly now: number }) => {
  switch (item.kind) {
    case "request": {
      const { request } = item
      const { dialog } = request
      if (dialog?.type === "choices") {
        const detail = dialog.detail ?? request.subject ?? ""
        if (request.kind === "plan") return <PlanBox item={item} fallback={detail} />
        return (
          <>
            {/* Another tool's name says what the box can't. */}
            {actionOf(request) === "other" && (
              <Heading>
                <Text text={subjectOf(item)} />
              </Heading>
            )}
            {detail && <CommandBox command={detail} />}
          </>
        )
      }
      // Its questions head their own menus.
      if (dialog?.type === "questions") return null
      return (
        <>
          <Heading>
            <Text text={subjectOf(item)} />
          </Heading>
          {dialog?.type === "raw" && (
            <pre
              className="console-box"
              tabIndex={0}
              aria-label="The prompt as the terminal shows it"
            >
              {dialog.text}
            </pre>
          )}
          <p className="console-note">
            Novadeck can&apos;t answer this prompt from here. Answer it in the terminal.
          </p>
        </>
      )
    }
    case "held":
      return <Held held={item.held} />
    case "ask": {
      const { ask } = item
      return (
        <>
          <Heading glyph={ask.shape.type === "action" ? "!" : "?"}>
            <Text text={ask.subject} />
          </Heading>
          {ask.hardToUndo && <p className="console-hard">! Hard to undo: {ask.hardToUndo}</p>}
          <Prose text={ask.body} />
          {ask.details && (
            <div className="console-detail">
              <Disclosure label="More detail">
                <Markdown text={ask.details} />
              </Disclosure>
            </div>
          )}
          {ask.shape.type === "action" && (
            <CommandBox command={ask.shape.command} folder={ask.shape.directory} copy />
          )}
        </>
      )
    }
    case "trouble":
      return <TroubleThing item={item} trouble={item.trouble} now={now} />
    case "update":
      return <Prose text={item.update.body} />
    case "feedback":
      return null
  }
}

// How a settled ask ended, said once in place of its menu.
const settledLine = (item: InboxRow): string | null => {
  if (!item.settled) return null
  const who = `@${item.source.handle}`
  if (item.settled.how === "withdrawn") return `${who} withdrew this ask. Nothing to answer.`
  if (item.settled.how === "dismissed") return `You dismissed this ask; ${who} was told.`
  return `You wrote to ${who} in its terminal, so this ask is settled.`
}

// Option details as the cursor reaches them.
const detailsOf = (details: Extract<Row, { type: "answer" }>["details"]): ReactNode =>
  details && (
    <>
      {details.details && <Markdown text={details.details} />}
      {details.code && (
        <>
          <span className="console-path">{details.code.path}</span>
          <pre className="console-box" tabIndex={0} aria-label={`Code for ${details.code.path}`}>
            {details.code.text}
          </pre>
        </>
      )}
    </>
  )

// The menu of every kind but a dialog of questions.
const RowsMenu = ({
  props,
  model,
  handle,
}: {
  readonly props: SheetContentProps
  readonly model: MenuModel
  readonly handle: React.Ref<MenuHandle>
}): React.JSX.Element => {
  const { item, answering, submit, change, reveal } = props
  const { drafts, setDraft } = useInboxContext()
  // An agent's ask keeps its words as a draft, on its row; other words are the sheet's.
  const [local, setLocal] = useState<Readonly<Record<number, string>>>({})
  const [pressed, setPressed] = useState<number | null>(null)
  const wordsOf = (at: number): string =>
    item.kind === "ask" ? (drafts[item.id] ?? noDraft).text : (local[at] ?? "")
  const setWords = (at: number, text: string): void =>
    item.kind === "ask"
      ? setDraft(item.id, { text })
      : setLocal((record) => ({ ...record, [at]: text }))
  const items = model.rows.map((row, at): MenuItem => {
    switch (row.type) {
      case "answer":
        return {
          key: `a${at}`,
          label: row.label,
          effect: row.effect,
          pick: row.pick,
          more: detailsOf(row.details),
        }
      case "words": {
        const value = wordsOf(at)
        return {
          key: `w${at}`,
          label: row.label,
          effect: null,
          words: {
            value,
            onChange: (text) => setWords(at, text),
            placeholder: row.placeholder,
            field: row.field,
            required: row.required,
            refused: value.trim() === "" ? null : row.refused(value),
            hint: item.kind === "ask" && model.rows.length > 1 ? "send your words instead" : "send",
          },
        }
      }
      case "reveal":
        return { key: `r${at}`, label: row.label, effect: row.effect }
      case "toggle":
        return { key: `t${at}`, label: row.label, effect: null, check: row.on }
    }
  })
  const run = (at: number): void => {
    const row = model.rows[at]
    if (!row) return
    if (row.type === "reveal") return reveal()
    if (row.type === "toggle") return change(row.change)
    setPressed(at)
    if (row.type === "answer") return submit(row.answer, row.receipt)
    const text = wordsOf(at)
    submit(row.answer(text), row.receipt(text))
  }
  return (
    <Menu
      label="Answers"
      items={items}
      hard={model.hard}
      busy={answering}
      pressed={answering ? pressed : null}
      onPress={run}
      onWords={run}
      handle={handle}
    />
  )
}

// An agent's own dialog of questions: a menu for each, one pick or several, and the
// person's own words where it takes them. One question of one pick sends at once; with
// several, Enter on the last sends them all.
const QuestionsMenu = ({
  props,
  dialog,
  questions,
  handles,
}: {
  readonly props: SheetContentProps
  readonly dialog: string
  readonly questions: readonly ChatQuestion[]
  readonly handles: React.RefObject<(MenuHandle | null)[]>
}): React.JSX.Element => {
  const { item, answering, submit } = props
  const { drafts, setDraft } = useInboxContext()
  const picks: Picks = drafts[item.id]?.picks ?? {}
  const setPicks = (next: Picks): void => setDraft(item.id, { picks: next })
  const [pressed, setPressed] = useState<{ question: number; at: number } | null>(null)
  const receipt = `Answered @${item.source.handle}'s ${questions.length > 1 ? "questions" : "question"}.`
  const send = (next: Picks): void => {
    if (!complete(next, questions)) return
    submit({ kind: "request", answer: questionsAnswer(dialog, next, questions) }, receipt)
  }
  const ticked = (next: Picks): number =>
    questions.reduce((count, question) => count + (next[question.id]?.options.length ?? 0), 0)
  return (
    <>
      {questions.map((question, index) => {
        const pick = picks[question.id]
        const last = index === questions.length - 1
        const words = pick?.text ?? ""
        const items: MenuItem[] = question.options.map((option) => {
          const { label, pick: its } = recommended(option.label)
          return {
            key: option.id,
            label,
            effect: option.description,
            pick: its,
            ...(question.multiSelect && { check: pick?.options.includes(option.id) ?? false }),
          }
        })
        if (question.text) {
          const count = ticked({ [question.id]: pick ?? { options: [], text: "" } })
          items.push({
            key: "own",
            label: "Reply in your own words",
            effect: null,
            ...(question.multiSelect && { check: words !== "" }),
            words: {
              value: words,
              onChange: (text) => setPicks(write(picks, question, text)),
              placeholder: `Reply to ${agentName(item.source.agent)}`,
              field: `Your answer to ${question.question}`,
              required: !question.multiSelect || count === 0,
              refused: null,
              hint: question.multiSelect
                ? count > 0
                  ? `send ${count} picked + your words`
                  : "send your words"
                : questions.length > 1 && !last
                  ? "next question"
                  : "send your words instead",
            },
          })
        }
        const next = (after: Picks): void => {
          if (!last) handles.current[index + 1]?.key("Home")
          else send(after)
        }
        return (
          <div className="console-question" key={question.id}>
            <Heading>
              {question.header && <span className="console-header">{question.header} · </span>}
              <Text text={question.question} />
            </Heading>
            <Menu
              label={question.question}
              items={items}
              multi={question.multiSelect}
              busy={answering}
              pressed={answering && pressed?.question === index ? pressed.at : null}
              handle={(handle) => {
                handles.current[index] = handle
              }}
              onPress={(at) => {
                const option = question.options[at]
                if (!option) {
                  // The words row, ticked or unticked in a menu of several picks: unticking
                  // leaves the words out.
                  if (question.multiSelect && words !== "") setPicks(write(picks, question, ""))
                  return
                }
                const after = choose(picks, question, option.id)
                setPicks(after)
                if (question.multiSelect) return
                setPressed({ question: index, at })
                next(after)
              }}
              onWords={() => {
                if (!answered(picks, question)) return
                setPressed({ question: index, at: items.length - 1 })
                next(picks)
              }}
              onSend={() => {
                if (!last) return handles.current[index + 1]?.key("Home")
                send(picks)
              }}
            />
          </div>
        )
      })}
      {questions.length > 1 && (
        <p className="console-note" role="status">
          {questions.filter((question) => answered(picks, question)).length} of {questions.length}{" "}
          answered
        </p>
      )}
    </>
  )
}

// One item's page under the head: its context, the thing, and the menu that answers it.
export const ConsoleSheet = (props: SheetContentProps): React.JSX.Element => {
  const { item, failed } = props
  const { now, drafts } = useInboxContext()
  const settled = settledLine(item)
  const dialog = item.kind === "request" ? item.request.dialog : null
  const questions = dialog?.type === "questions" ? dialog : null
  const model = questions ? null : menuOf(item, now)
  const one = useRef<MenuHandle | null>(null)
  const several = useRef<(MenuHandle | null)[]>([])
  // The picks as of the last render, for the keys below.
  const picks = useRef<Picks>({})
  const drafted = drafts[item.id]?.picks
  useLayoutEffect(() => {
    picks.current = drafted ?? {}
  })

  // A number or an arrow pressed on the item's row, the sheet's title or the page itself goes
  // to the menu: the menu of the first question still unanswered, where there are several.
  // Enter and Space there stay the row's and the title's own, so a key pressed twice to open
  // the sheet answers nothing.
  useEffect(() => {
    if (settled) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      if (!/^([1-9]|ArrowUp|ArrowDown)$/.test(event.key)) return
      const target = event.target
      const outside =
        target === document.body ||
        target === document.documentElement ||
        (target instanceof Element &&
          (rowOf(item.id)?.contains(target) || target.matches(".inbox-sheet-title")))
      if (!outside) return
      const open = questions
        ? questions.questions.findIndex((question) => !answered(picks.current, question))
        : -1
      const handle = questions ? several.current[Math.max(0, open)] : one.current
      if (handle?.key(event.key)) event.preventDefault()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [item.id, settled, questions])

  return (
    <div className="inbox-sheet-scroll console-page">
      <Context item={item} />
      <Thing item={item} now={now} />
      {settled ? (
        <p className="console-settled" role="status">
          {settled}
        </p>
      ) : questions ? (
        <QuestionsMenu
          props={props}
          dialog={questions.id}
          questions={questions.questions}
          handles={several}
        />
      ) : (
        model && model.rows.length > 0 && <RowsMenu props={props} model={model} handle={one} />
      )}
      <Failure message={failed} />
    </div>
  )
}
