import type { AgentStep } from "@novadeck/core/agents/steps"
import type { ChatQuestion } from "@novadeck/core/conversation"
/* oxlint-disable react/no-array-index-key -- Lines are read from text and transcripts that have no ids; they never reorder. */
import {
  answered,
  choose,
  questionsAnswer,
  write,
  type Picks,
} from "@novadeck/core/conversation/picks"
import { grantTitle } from "@novadeck/core/grants"
import type { HeldMessage, InboxAnswer, InboxRow, Trouble } from "@novadeck/core/inbox"
import { unsaidWaits, waitsText } from "@novadeck/core/messages"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { Markdown } from "@novadeck/toolkit/Markdown"
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"

import { useAgentContext } from "./agent-context"
import {
  answerable,
  menuOf,
  resetLabel,
  type Menu as MenuModel,
  type MenuRow,
} from "./console-menu"
import { ApprovalWords, GrantCard, GrantWords } from "./GrantCard"
import { rowOf } from "./inbox-dom"
import { actionOf, agentName, limitWindow, recommended, subjectOf } from "./inbox-text"
import { noDraft, useInboxContext, type Sent } from "./InboxProvider"
import { Menu, wordsLimit, type MenuHandle, type MenuItem } from "./Menu"
import { usePlanAnswered, usePlanText } from "./plan-text"
import { CommandBox, Disclosure, Failure, Text } from "./sheet-parts"

// The Console sheet: one layout for every kind. The person's last words to the agent and the
// few steps it took since; the thing it asks about, word for word; and a numbered menu that
// answers it. Nothing here says what the head or the row says already.

// What the sheet gets: its row, and what it knows around it.
export type SheetContentProps = {
  readonly row: InboxRow
  // The answer the person gave, once they have.
  readonly sent: Sent | undefined
  // Whether an answer is on its way, and why the last one didn't take.
  readonly answering: boolean
  readonly failed: string | undefined
  // Answers the row, with the receipt that tells the person what it did.
  readonly submit: (answer: InboxAnswer, note: string) => void
  // Changes how the row is handled, without answering it: it stays.
  readonly change: (answer: InboxAnswer) => void
  // Shows the row's terminal.
  readonly reveal: () => void
}

// How long the room for the context stays kept while the agent's transcript is read. An agent
// with none (a plain shell) gives the room back then.
export const contextWaitMs = 2000

// Your last words, never an agent's, and up to three steps that edited, ran or failed. It fills in
// late and in batches, so the block holds the room of its longest self from the start: the menu
// under it must not move as the person aims at it. Nothing where there is no transcript.
const Context = ({ row }: { readonly row: InboxRow }): React.JSX.Element | null => {
  const context = useAgentContext(row)
  const [waiting, setWaiting] = useState(true)
  useEffect(() => {
    const timer = setTimeout(() => setWaiting(false), contextWaitMs)
    return () => clearTimeout(timer)
  }, [])
  if (!context || (!context.said && context.steps.length === 0))
    return waiting ? <div className="console-tail" data-reserved="" aria-hidden="true" /> : null
  const { said, steps } = context
  return (
    <div className="console-tail" data-reserved="">
      {said && (
        <div className="console-you">
          <span className="console-gut" aria-hidden="true">
            ›
          </span>
          <span className="console-line" title={said.text}>
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

// The plan in a box of its own, as the chat draws Markdown: only the box scrolls. While its
// text is on its way the box says so; where there is none, the dialog's own words stand in.
const PlanBox = ({ row, fallback }: { readonly row: InboxRow; readonly fallback: string }) => {
  const plan = usePlanText(row)
  if (plan === undefined)
    return (
      <div className="console-planbox" data-loading="true">
        <div className="console-planbar">
          <span>plan</span>
          <span>loading</span>
        </div>
        <div className="console-planscroll" aria-busy="true">
          Loading the plan…
        </div>
      </div>
    )
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
  row,
  trouble,
  now,
}: {
  readonly row: InboxRow
  readonly trouble: Trouble
  readonly now: number
}): React.JSX.Element => {
  const agent = agentName(row.source.agent)
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
          <div className="console-box" aria-label={`What @${row.source.handle} ran`}>
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

// What the row is about, word for word.
const Thing = ({ row, now }: { readonly row: InboxRow; readonly now: number }) => {
  switch (row.kind) {
    case "request": {
      const { request } = row
      const { dialog } = request
      if (dialog?.type === "choices" && answerable(row)) {
        const detail = dialog.detail ?? request.subject ?? ""
        if (request.kind === "plan") return <PlanBox row={row} fallback={detail} />
        return (
          <>
            {/* Another tool's name says what the box can't. */}
            {actionOf(request) === "other" && (
              <Heading>
                <Text text={subjectOf(row)} />
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
            <Text text={subjectOf(row)} />
          </Heading>
          {dialog?.type === "choices" && dialog.detail && <CommandBox command={dialog.detail} />}
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
      return <Held held={row.held} />
    case "grant":
      return (
        <>
          <Heading glyph="!">{grantTitle(row.proposal, row.source.handle)}</Heading>
          <GrantWords proposal={row.proposal} />
        </>
      )
    case "ask": {
      const { ask } = row
      return (
        <>
          <Heading glyph={ask.shape.type === "action" || ask.shape.type === "approval" ? "!" : "?"}>
            <Text text={ask.subject} />
          </Heading>
          {ask.hardToUndo && <p className="console-hard">! Hard to undo: {ask.hardToUndo}</p>}
          {ask.shape.type === "approval" ? (
            // The agent's own words stay a muted note: Novadeck's sentence is the one under it.
            ask.body.trim() !== "" && (
              <p className="console-note">
                <Text text={ask.body} />
              </p>
            )
          ) : (
            <Prose text={ask.body} />
          )}
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
          {ask.shape.type === "approval" && (
            <ApprovalWords row={row} commands={ask.shape.commands} />
          )}
        </>
      )
    }
    case "trouble":
      return <TroubleThing row={row} trouble={row.trouble} now={now} />
    case "update":
      return <Prose text={row.update.body} />
  }
}

// How a settled ask ended, said once in place of its menu.
const settledLine = (row: InboxRow): string | null => {
  if (!row.settled) return null
  const who = `@${row.source.handle}`
  if (row.settled.how === "withdrawn") return `${who} withdrew this ask. Nothing to answer.`
  if (row.settled.how === "dismissed") return `You dismissed this ask; ${who} was told.`
  return `You wrote to ${who} in its terminal, so this ask is settled.`
}

// Option details as the cursor reaches them.
const detailsOf = (details: Extract<MenuRow, { type: "answer" }>["details"]): ReactNode =>
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
const ChoicesMenu = ({
  props,
  model,
  handle,
  arrived,
}: {
  readonly props: SheetContentProps
  readonly model: MenuModel
  readonly handle: React.Ref<MenuHandle>
  readonly arrived: boolean
}): React.JSX.Element => {
  const { row, answering, submit, change, reveal } = props
  const { drafts, setDraft, dismiss } = useInboxContext()
  // An agent's ask keeps its words as a draft, on its row; other words are the sheet's.
  const [local, setLocal] = useState<Readonly<Record<number, string>>>({})
  const [pressed, setPressed] = useState<number | null>(null)
  const wordsOf = (at: number): string =>
    row.kind === "ask" ? (drafts[row.id] ?? noDraft).text : (local[at] ?? "")
  const setWords = (at: number, text: string): void =>
    row.kind === "ask"
      ? setDraft(row.id, { text })
      : setLocal((record) => ({ ...record, [at]: text }))
  // The rows that answer, the way to the terminal aside.
  const rows = model.rows.filter((menuRow) => menuRow.type !== "decline" || dismiss)
  const answers = rows.filter((menuRow) => menuRow.type !== "reveal").length
  const items = rows.map((menuRow, at): MenuItem => {
    switch (menuRow.type) {
      case "answer":
        return {
          key: `a${at}`,
          label: menuRow.label,
          effect: menuRow.effect,
          pick: menuRow.pick,
          ...(menuRow.hard && { arms: true }),
          more: detailsOf(menuRow.details),
        }
      case "words": {
        const value = wordsOf(at)
        return {
          key: `w${at}`,
          label: menuRow.label,
          effect: null,
          words: {
            value,
            onChange: (text) => setWords(at, text),
            placeholder: menuRow.placeholder,
            field: menuRow.field,
            required: menuRow.required,
            refused: value.trim() === "" ? null : menuRow.refused(value),
            hint: row.kind === "ask" && answers > 1 ? "send your words instead" : "send",
          },
        }
      }
      case "decline":
        return { key: `d${at}`, label: menuRow.label, effect: null }
      case "reveal":
        return { key: `r${at}`, label: menuRow.label, effect: menuRow.effect, away: true }
      case "toggle":
        return { key: `t${at}`, label: menuRow.label, effect: null, check: menuRow.on }
    }
  })
  const run = (at: number): void => {
    const menuRow = rows[at]
    if (!menuRow) return
    if (menuRow.type === "reveal") return reveal()
    if (menuRow.type === "decline") {
      setPressed(at)
      return dismiss?.(row.id)
    }
    if (menuRow.type === "toggle") return change(menuRow.change)
    setPressed(at)
    if (menuRow.type === "answer") {
      submit(menuRow.answer, menuRow.receipt)
      if (menuRow.reveal) reveal()
      return
    }
    const text = wordsOf(at)
    if (text.length > wordsLimit) return
    submit(menuRow.answer(text), menuRow.receipt(text))
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
      arrived={arrived}
    />
  )
}

// What is answered: the words of a question whose words are unticked stay out.
const counted = (all: Picks, left: readonly string[]): Picks =>
  Object.fromEntries(
    Object.entries(all).map(([id, pick]) => [id, left.includes(id) ? { ...pick, text: "" } : pick]),
  )

const nameOf = (question: ChatQuestion): string => question.header ?? question.question

// An agent's own dialog of questions: a menu for each, one pick or several, and the
// person's own words where it takes them. The answer goes the moment every question has one;
// until then focus goes to the first that has none, and the page says which are left.
const QuestionsMenu = ({
  props,
  dialog,
  questions,
  handles,
  arrived,
}: {
  readonly props: SheetContentProps
  readonly dialog: string
  readonly questions: readonly ChatQuestion[]
  readonly handles: React.RefObject<(MenuHandle | null)[]>
  readonly arrived: boolean
}): React.JSX.Element => {
  const { row, answering, submit, reveal } = props
  const { drafts, setDraft } = useInboxContext()
  const picks: Picks = drafts[row.id]?.picks ?? {}
  const leftOut = drafts[row.id]?.leftOut ?? []
  const setPicks = (next: Picks, left: readonly string[] = leftOut): void =>
    setDraft(row.id, { picks: next, leftOut: left })
  const [pressed, setPressed] = useState<{ question: number; at: number } | null>(null)
  const receipt = `Answered @${row.source.handle}'s ${questions.length > 1 ? "questions" : "question"}.`
  const now = counted(picks, leftOut)
  const unanswered = questions.filter((question) => !answered(now, question))
  const over = questions.filter((question) => (now[question.id]?.text.length ?? 0) > wordsLimit)
  // Sends where every question has an answer within the limit; else takes the person to the
  // first that has none, or to the words that are too long.
  const finish = (next: Picks, left: readonly string[]): void => {
    const ready = counted(next, left)
    const open = questions.findIndex((question) => !answered(ready, question))
    if (open >= 0) return void handles.current[open]?.key("Home")
    const long = questions.findIndex(
      (question) => (ready[question.id]?.text.length ?? 0) > wordsLimit,
    )
    // Its words row comes after its options.
    if (long >= 0) return void handles.current[long]?.go(questions[long]!.options.length)
    submit({ kind: "request", answer: questionsAnswer(dialog, ready, questions) }, receipt)
  }
  return (
    <>
      {questions.map((question, index) => {
        const pick = picks[question.id]
        const words = pick?.text ?? ""
        const single = !question.multiSelect
        const items: MenuItem[] = question.options.map((option) => {
          const { label, pick: its } = recommended(option.label)
          return {
            key: option.id,
            label,
            effect: option.description,
            pick: its,
            ...(question.multiSelect && { check: pick?.options.includes(option.id) ?? false }),
            ...(single && { chosen: pick?.options.includes(option.id) ?? false }),
          }
        })
        if (question.text) {
          const count = pick?.options.length ?? 0
          const others = questions.every((each, at) => at === index || answered(now, each))
          items.push({
            key: "own",
            label: "Reply in your own words",
            effect: null,
            ...(question.multiSelect && { check: words !== "" && !leftOut.includes(question.id) }),
            ...(single && { chosen: words.trim() !== "" }),
            words: {
              value: words,
              // Writing ticks the words again if they were left out.
              onChange: (text) =>
                setPicks(
                  write(picks, question, text),
                  leftOut.filter((id) => id !== question.id),
                ),
              placeholder: `Reply to ${agentName(row.source.agent)}`,
              field: `Your answer to ${question.question}`,
              required: !question.multiSelect || count === 0,
              refused: null,
              hint: !others
                ? "next question"
                : question.multiSelect
                  ? count > 0
                    ? `send ${count} picked + your words`
                    : "send your words"
                  : "send your words instead",
            },
          })
        }
        // The words row, where there is one, before the way to the terminal.
        const wordsAt = items.length - 1
        // Every question's menu ends on the way to the terminal.
        const terminalAt = items.length
        items.push({ key: "terminal", label: "Go to terminal", effect: null, away: true })
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
              arrived={arrived && index === 0}
              pressed={answering && pressed?.question === index ? pressed.at : null}
              handle={(handle) => {
                handles.current[index] = handle
              }}
              onPress={(at) => {
                if (at === terminalAt) return reveal()
                const option = question.options[at]
                if (!option) {
                  // The words row, in a menu of several picks: ticking brings the words
                  // back, unticking leaves them out of the answer and keeps them.
                  if (!question.multiSelect) return
                  if (words !== "" && !leftOut.includes(question.id))
                    setPicks(picks, [...leftOut, question.id])
                  else if (leftOut.includes(question.id))
                    setPicks(
                      picks,
                      leftOut.filter((id) => id !== question.id),
                    )
                  return
                }
                const after = choose(picks, question, option.id)
                setPicks(after)
                if (question.multiSelect) return
                setPressed({ question: index, at })
                finish(after, leftOut)
              }}
              onWords={() => {
                setPressed({ question: index, at: wordsAt })
                finish(picks, leftOut)
              }}
              onSend={() => finish(picks, leftOut)}
            />
          </div>
        )
      })}
      {questions.length > 1 && (
        <p className="console-note" role="status">
          {questions.length - unanswered.length} of {questions.length} answered
          {unanswered.length > 0 && unanswered.length < questions.length && (
            <> · still to answer: {unanswered.map(nameOf).join("; ")}</>
          )}
          {over.length > 0 && <> · over the 4,096 character limit: {over.map(nameOf).join("; ")}</>}
        </p>
      )}
    </>
  )
}

// One row's page under the head: its context, the thing, and the menu that answers it.
export const ConsoleSheet = (shown: SheetContentProps): React.JSX.Element => {
  const { row, failed, sent } = shown
  // A plan approval answered spends the plan its sheet showed: a round sent back is never the
  // next approval's plan.
  const planAnswered = usePlanAnswered()
  const props: SheetContentProps = {
    ...shown,
    submit: (answer, note) => {
      if (row.kind === "request" && row.request.kind === "plan") planAnswered(row)
      shown.submit(answer, note)
    },
  }
  const { now, drafts, receipt } = useInboxContext()
  // An answered row opened again says what its answer did, in place of its menu.
  const settled = settledLine(row) ?? sent?.note ?? null
  // Whether the Inbox moved on to it from another's answer.
  const arrived = receipt !== null && receipt.from !== row.id
  const dialog = row.kind === "request" ? row.request.dialog : null
  const questions = dialog?.type === "questions" ? dialog : null
  const model = questions ? null : menuOf(row, now)
  const one = useRef<MenuHandle | null>(null)
  const several = useRef<(MenuHandle | null)[]>([])
  // The picks as of the last render, for the keys below.
  const picks = useRef<Picks>({})
  const drafted = drafts[row.id]?.picks
  useLayoutEffect(() => {
    picks.current = counted(drafted ?? {}, drafts[row.id]?.leftOut ?? [])
  })

  // A number or an arrow pressed on the row or the sheet's title goes to the menu: the
  // menu of the first question still unanswered, where there are several. Enter and Space
  // there stay the row's and the title's own, so a key pressed twice to open the sheet answers
  // nothing; nor does a key held, nor one pressed with focus nowhere, on a sheet not yet seen.
  useEffect(() => {
    if (settled) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      if (!/^([1-9]|ArrowUp|ArrowDown)$/.test(event.key)) return
      if (event.repeat && /^[1-9]$/.test(event.key)) return
      const target = event.target
      const outside =
        target instanceof Element &&
        (rowOf(row.id)?.contains(target) || target.matches(".inbox-sheet-title"))
      if (!outside) return
      const open = questions
        ? questions.questions.findIndex((question) => !answered(picks.current, question))
        : -1
      const handle = questions ? several.current[Math.max(0, open)] : one.current
      if (handle?.key(event.key)) event.preventDefault()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [row.id, settled, questions])

  return (
    <div className="inbox-sheet-scroll console-page">
      <Context row={row} />
      <Thing row={row} now={now} />
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
          arrived={arrived}
        />
      ) : row.kind === "grant" ? (
        <GrantCard props={props} proposal={row.proposal} handle={one} arrived={arrived} />
      ) : (
        model &&
        model.rows.length > 0 && (
          <ChoicesMenu props={props} model={model} handle={one} arrived={arrived} />
        )
      )}
      <Failure message={failed} />
    </div>
  )
}
