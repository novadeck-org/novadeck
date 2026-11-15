import { Fact, Since } from "@novadeck/chat/Fact"
import { PersonWords } from "@novadeck/chat/PersonWords"
import { ToolCalls } from "@novadeck/chat/ToolCalls"
import type { ChatAnswer, ChatRequest } from "@novadeck/core/conversation"
import {
  rowKey,
  type HeldMessage,
  type InboxAnswer,
  type InboxRow,
  type Trouble,
} from "@novadeck/core/inbox"
import { unsaidWaits, waitsText } from "@novadeck/core/messages"
import { Detail } from "@novadeck/requests/Detail"
import type { DialogDraft } from "@novadeck/requests/drafts"
import { answerWordsLimit, Menu, type MenuHandle, type MenuItem } from "@novadeck/requests/Menu"
import { RequestCard, RequestFrame, type RequestPlace } from "@novadeck/requests/RequestCard"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { Markdown } from "@novadeck/toolkit/Markdown"
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"

import { useAgentContext, useRefused } from "./agent-context"
import {
  menuOf,
  requestReceipt,
  resetLabel,
  type Menu as MenuModel,
  type MenuRow,
  type OwnRow,
} from "./console-menu"
import { rowOf } from "./inbox-dom"
import { agentName, endedLine, limitWindow, subjectOf } from "./inbox-text"
import { noDraft, useInboxContext, type Sent } from "./InboxProvider"
import { usePlanAnswered, usePlanText } from "./plan-text"
import { Disclosure, Failure, Text } from "./sheet-parts"

// The Console sheet: the person's last words to the agent and the few steps it took since, drawn
// as the chat draws them; then a card, as the chat's: a request's is the chat's own card, and the
// Inbox's own kinds (an agent's ask, a held message, trouble, an update) are drawn in its frame,
// with its menu. Nothing here says what the head or the row says already.

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

// How long a card that moved, as the context over it came in, takes no click: the person aimed
// at where a row was.
export const movedGuardMs = 400

// A request takes focus from anywhere in the sheet that holds none of the person's words, and its
// pages scroll with the sheet's page.
const place: RequestPlace = {
  area: (dialog) => dialog.closest(".inbox-sheet"),
  scroller: (dialog) => dialog.closest(".inbox-sheet-scroll"),
}
const sheetArea = place.area

// How long a request has waited, as the chat's card says it.
const askedClock = (askedAt: number): React.ReactNode => (
  <Fact keep>
    <Since since={askedAt} before="asked " after=" ago" />
  </Fact>
)

// Your last words, never an agent's, as the chat draws your prompt, and the calls of the agent's
// latest steps since, as the chat draws a run of them. It fills in late, and takes the room it
// needs: `moved` hears each time it grows or changes, as the card under it moves.
const Context = ({
  row,
  moved,
}: {
  readonly row: InboxRow
  readonly moved: () => void
}): React.JSX.Element | null => {
  const context = useAgentContext(row)
  const said = context?.said ?? null
  const entries = context?.entries ?? []
  const shape = `${said?.text ?? ""}\n${entries.map((entry) => entry.id).join(",")}`
  const first = useRef(true)
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    moved()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- What it shows moves the card.
  }, [shape, moved])
  if (!said && entries.length === 0) return null
  return (
    <section className="chat-thread inbox-context" aria-label="Where it was">
      {said && <PersonWords id={`said:${row.id}`} text={said.text} at={said.at} />}
      {entries.length > 0 && <ToolCalls entries={entries} live={false} />}
    </section>
  )
}

// The plan in a box of its own, as the detail box draws what a request asks, its Markdown as the
// chat draws Markdown: only the box scrolls. While its text is on its way the box says so; where
// there is none, the dialog's own words stand in.
const PlanBox = ({ row, fallback }: { readonly row: InboxRow; readonly fallback: string }) => {
  const plan = usePlanText(row)
  if (plan === undefined)
    return (
      <div className="request-detail request-plan" data-loading="">
        <span className="request-detail-bar">
          <span>plan · loading</span>
        </span>
        <div className="request-detail-text" aria-busy="true">
          Loading the plan…
        </div>
      </div>
    )
  const text = plan ?? fallback
  const lines = text.split("\n").length
  return (
    <div className="request-detail request-plan">
      <span className="request-detail-bar">
        <span>plan · {lines === 1 ? "1 line" : `${lines} lines`}</span>
      </span>
      <div className="request-detail-text" tabIndex={0} aria-label="The plan">
        <Markdown text={text} />
      </div>
    </div>
  )
}

// A request's sheet: the chat's own card, answered here. The answer goes through the Inbox,
// which moves on with its receipt; the card's draft is the Inbox's, so it stays with its row.
const RequestSheet = ({
  props,
  request,
  handle,
  arrived,
}: {
  readonly props: SheetContentProps
  readonly request: ChatRequest
  readonly handle: React.Ref<MenuHandle>
  readonly arrived: boolean
}): React.JSX.Element => {
  const { row, answering, failed, sent, submit, reveal } = props
  const { drafts, setDraft } = useInboxContext()
  const refused = useRefused()
  const planAnswered = usePlanAnswered()
  const key = rowKey(row)
  // The card's answer settles once the Inbox has it: taken, or failed, which the sheet says.
  const waiting = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!waiting.current || (answering && failed === undefined && sent === undefined)) return
    waiting.current()
    waiting.current = null
  }, [answering, failed, sent])
  const send = (answer: ChatAnswer): Promise<void> =>
    new Promise((resolve) => {
      waiting.current = resolve
      if (request.kind === "plan") planAnswered(row)
      submit({ kind: "request", answer }, requestReceipt(request, row.source.handle, answer))
      // Talking it over is done in the terminal.
      if (answer.type === "chat") reveal()
    })
  const { dialog } = request
  const plan = request.kind === "plan" && dialog?.type === "choices"
  return (
    <RequestCard
      request={request}
      agent={agentName(row.source.agent)}
      send={send}
      onAnswerInTerminal={reveal}
      // Where focus goes after an answer is the Inbox's: on to the next row's sheet.
      onSettled={() => {}}
      onSubmitted={() => {}}
      refused={refused}
      place={place}
      clock={askedClock}
      menu={handle}
      arrived={arrived}
      draft={{
        value: drafts[key]?.request ?? {},
        onChange: (next: DialogDraft) => setDraft(key, { request: next }),
      }}
      detail={plan ? <PlanBox row={row} fallback={dialog.detail ?? request.subject ?? ""} /> : null}
      harness={row.source.agent}
    />
  )
}

// A card of the Inbox's own: the frame of a request's card, with its title line.
const titleOf = (row: OwnRow): string => {
  switch (row.kind) {
    case "ask":
      return row.ask.shape.type === "action" ? "Needs you to act" : "Has a question"
    case "held":
      return "Holds a message"
    case "trouble":
      if (row.trouble.type === "failed") return "Ended its turn on an error"
      if (row.trouble.type === "limit") return "Hit its usage limit"
      if (row.trouble.type === "stuck") return "Seems stuck"
      return "Can't get your message"
    case "update":
      return "Has an update"
  }
}

const Prose = ({ text }: { readonly text: string }): React.JSX.Element | null =>
  text.trim() === "" ? null : (
    <div className="request-prose">
      <Markdown text={text} />
    </div>
  )

const Note = ({ children }: { readonly children: ReactNode }): React.JSX.Element => (
  <p className="request-note">{children}</p>
)

const Held = ({ held }: { readonly held: HeldMessage }): React.JSX.Element => (
  <>
    <p className="request-subject">
      <HandleChip handle={held.from.handle} /> {held.from.title}
      <span aria-hidden="true"> → </span>
      <HandleChip handle={held.to.handle} /> {held.to.title}
    </p>
    <Detail text={held.text} label="The message" />
    <Note>
      {held.heldFor === "loop" ? (
        <>
          <HandleChip handle={held.from.handle} /> and <HandleChip handle={held.to.handle} /> kept
          messaging while neither did any work, so Novadeck holds their thread.
        </>
      ) : (
        "Novadeck holds this thread for you."
      )}
    </Note>
  </>
)

// What a stuck agent kept running, a line each, with what came of it and how many times.
const evidenceText = (trouble: Extract<Trouble, { type: "stuck" }>): string =>
  trouble.evidence
    .map(
      (line) =>
        `${line.text}${line.times > 1 ? `  ×${line.times}` : ""}${line.result ? `\n  └ ${line.result}` : ""}`,
    )
    .join("\n")

const TroubleThing = ({
  row,
  trouble,
  now,
}: {
  readonly row: OwnRow
  readonly trouble: Trouble
  readonly now: number
}): React.JSX.Element => {
  const agent = agentName(row.source.agent)
  switch (trouble.type) {
    case "failed":
      return trouble.error ? (
        <Detail text={trouble.error} label="The error" />
      ) : (
        <Note>{agent} ended its turn on an error and gave no reason.</Note>
      )
    case "limit":
      return (
        <p className="request-prose">
          {agent} used up its {limitWindow(trouble.minutes, trouble.scope)} window, which{" "}
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
          <p className="request-prose">
            <Text text={trouble.summary} />
          </p>
          <Detail text={evidenceText(trouble)} label={`What @${row.source.handle} ran`} />
        </>
      )
    case "waits":
      return (
        <p className="request-prose">
          {trouble.waits ? waitsText[trouble.waits] : unsaidWaits.text}
        </p>
      )
  }
}

// What the row is about, word for word.
const Thing = ({ row, now }: { readonly row: OwnRow; readonly now: number }) => {
  switch (row.kind) {
    case "held":
      return <Held held={row.held} />
    case "ask": {
      const { ask } = row
      return (
        <>
          <p className="request-subject">
            <Text text={ask.subject} />
          </p>
          {ask.hardToUndo && <p className="request-hard">Hard to undo: {ask.hardToUndo}</p>}
          <Prose text={ask.body} />
          {ask.details && (
            <div className="request-prose">
              <Disclosure label="More detail">
                <Markdown text={ask.details} />
              </Disclosure>
            </div>
          )}
          {ask.shape.type === "action" && (
            <Detail
              text={ask.shape.command}
              label="The command"
              folder={ask.shape.directory}
              command
              copy
            />
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

// Option details as the cursor reaches them.
const detailsOf = (details: Extract<MenuRow, { type: "answer" }>["details"]): ReactNode =>
  details && (
    <>
      {details.details && <Markdown text={details.details} />}
      {details.code && (
        <Detail text={details.code.text} label={details.code.path} folder={details.code.path} />
      )}
    </>
  )

// The most characters of the person's words an ask's reply takes (`askAnswer`'s text); a
// request's answer and a nudge, which goes as the agent's prompt, take `answerWordsLimit`.
const askWordsLimit = 4096

// The menu of a card of the Inbox's own.
const OwnMenu = ({
  props,
  row,
  model,
  handle,
  arrived,
}: {
  readonly props: SheetContentProps
  readonly row: OwnRow
  readonly model: MenuModel
  readonly handle: React.Ref<MenuHandle>
  readonly arrived: boolean
}): React.JSX.Element => {
  const { answering, submit, change, reveal } = props
  const { drafts, setDraft } = useInboxContext()
  // An agent's ask keeps its words as a draft, on its row; other words are the sheet's.
  const [local, setLocal] = useState<Readonly<Record<number, string>>>({})
  const [pressed, setPressed] = useState<number | null>(null)
  const wordsOf = (at: number): string =>
    row.kind === "ask" ? (drafts[rowKey(row)] ?? noDraft).text : (local[at] ?? "")
  const setWords = (at: number, text: string): void =>
    row.kind === "ask"
      ? setDraft(rowKey(row), { text })
      : setLocal((record) => ({ ...record, [at]: text }))
  // The rows that answer, the way to the terminal aside.
  const answers = model.rows.filter((menuRow) => menuRow.type !== "reveal").length
  const limit = row.kind === "ask" ? askWordsLimit : answerWordsLimit
  const items = model.rows.map((menuRow, at): MenuItem => {
    switch (menuRow.type) {
      case "answer":
        return {
          key: `a${at}`,
          label: <Text text={menuRow.label} />,
          effect: menuRow.effect && <Text text={menuRow.effect} />,
          pick: menuRow.pick,
          ...(menuRow.hard && { arms: true }),
          more: detailsOf(menuRow.details),
        }
      case "words": {
        const value = wordsOf(at)
        return {
          key: `w${at}`,
          label: <Text text={menuRow.label} />,
          words: {
            value,
            onChange: (text) => setWords(at, text),
            // The row is the field: its label says what to write, and names it.
            placeholder: menuRow.label,
            field: menuRow.label,
            required: menuRow.required,
            refused: value.trim() === "" ? null : menuRow.refused(value),
            hint: row.kind === "ask" && answers > 1 ? "send your words instead" : "send",
            limit,
          },
        }
      }
      case "reveal":
        return {
          key: `r${at}`,
          label: <Text text={menuRow.label} />,
          effect: menuRow.effect && <Text text={menuRow.effect} />,
          away: true,
        }
      case "toggle":
        return { key: `t${at}`, label: <Text text={menuRow.label} />, check: menuRow.on }
    }
  })
  const run = (at: number): void => {
    const menuRow = model.rows[at]
    if (!menuRow) return
    if (menuRow.type === "reveal") return reveal()
    if (menuRow.type === "toggle") return change(menuRow.change)
    setPressed(at)
    if (menuRow.type === "answer") {
      submit(menuRow.answer, menuRow.receipt)
      if (menuRow.reveal) reveal()
      return
    }
    const text = wordsOf(at)
    if (text.length > limit) return
    submit(menuRow.answer(text), menuRow.receipt(text))
  }
  return (
    <div className="request-dialog">
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
        area={sheetArea}
      />
    </div>
  )
}

// A card of the Inbox's own kinds, in the frame of a request's. Resolved, it has no menu: it
// says how it ended in its place.
const OwnCard = ({
  props,
  row,
  settled,
  handle,
  arrived,
}: {
  readonly props: SheetContentProps
  readonly row: OwnRow
  readonly settled: string | null
  readonly handle: React.Ref<MenuHandle>
  readonly arrived: boolean
}): React.JSX.Element => {
  const { now } = useInboxContext()
  const title = titleOf(row)
  const model = menuOf(row, now)
  return (
    <RequestFrame
      kind={row.kind}
      label={`${title}: @${row.source.handle}`}
      title={title}
      busy={props.answering}
    >
      <Thing row={row} now={now} />
      {settled ? (
        <p className="request-note" role="status">
          {settled}
        </p>
      ) : (
        model.rows.length > 0 && (
          <OwnMenu props={props} row={row} model={model} handle={handle} arrived={arrived} />
        )
      )}
    </RequestFrame>
  )
}

// What a request's card says once it is over, opened again: what it asked and how it ended, in
// its frame, with nothing to answer.
const ResolvedRequest = ({
  row,
  request,
  note,
}: {
  readonly row: InboxRow
  readonly request: ChatRequest
  readonly note: string
}): React.JSX.Element => {
  const { dialog } = request
  // What the person answered says "Answered"; anything else that ended it, "Resolved".
  const title = !row.settled || row.settled.how === "answered" ? "Answered" : "Resolved"
  return (
    <RequestFrame kind={request.kind} label={`${title}: ${request.tool}`} title={title}>
      <p className="request-subject">{request.subject ?? subjectOf(row)}</p>
      {dialog?.type === "choices" && dialog.detail && <Detail text={dialog.detail} label="Asked" />}
      {dialog?.type === "questions" &&
        dialog.questions.map((question) => (
          <p className="request-prose" key={question.id}>
            {question.question}
          </p>
        ))}
      {dialog?.type === "form" && <p className="request-prose">{dialog.message}</p>}
      <p className="request-note" role="status">
        {note}
      </p>
    </RequestFrame>
  )
}

// Where the card stands on the page, where it is drawn.
const cardTopIn = (page: HTMLElement | null): number | undefined =>
  page?.querySelector(".request-card")?.getBoundingClientRect().top

// One row's page under the head: its context, then its card.
export const ConsoleSheet = (props: SheetContentProps): React.JSX.Element => {
  const { row, failed, sent } = props
  const { receipt } = useInboxContext()
  // A resolved row, or an answered one opened again, says how it ended or what its answer did,
  // in place of its menu.
  const settled = endedLine(row) ?? sent?.note ?? null
  // Whether the Inbox moved on to it from another's answer.
  const arrived = receipt !== null && receipt.from !== row.id
  const handle = useRef<MenuHandle | null>(null)

  // Until when a click on the card is held back: it moved as the context over it came in. The
  // context changes as its agent works on, often in the room it had: only a card that moved,
  // from where it stood after the last render, holds its clicks back.
  const movedUntil = useRef(0)
  const pageRef = useRef<HTMLDivElement>(null)
  const lastTop = useRef<number | undefined>(undefined)
  useLayoutEffect(() => {
    lastTop.current = cardTopIn(pageRef.current)
  })
  const moved = useCallback(() => {
    const before = lastTop.current
    const now = cardTopIn(pageRef.current)
    lastTop.current = now
    if (before !== undefined && now !== undefined && Math.abs(now - before) < 1) return
    movedUntil.current = Date.now() + movedGuardMs
  }, [])

  // A number or an arrow pressed on the row or the sheet's title goes to the card's menu: the
  // page of a dialog of questions on screen. Enter and Space there stay the row's and the
  // title's own, so a key pressed twice to open the sheet answers nothing; nor does a key held,
  // nor one pressed with focus nowhere, on a sheet not yet seen.
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
      if (handle.current?.key(event.key)) event.preventDefault()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [row.id, settled])

  return (
    <div
      ref={pageRef}
      className="inbox-sheet-scroll console-page chat-inline"
      onClickCapture={(event) => {
        if (Date.now() >= movedUntil.current) return
        if (!(event.target instanceof Element) || !event.target.closest(".request-card")) return
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {!row.settled && <Context row={row} moved={moved} />}
      {row.kind === "request" ? (
        settled ? (
          <ResolvedRequest row={row} request={row.request} note={settled} />
        ) : (
          <RequestSheet props={props} request={row.request} handle={handle} arrived={arrived} />
        )
      ) : (
        <OwnCard
          // Opening an update reads it, which is no answer to wait on: its follow-up stays on offer.
          props={row.kind === "update" ? { ...props, answering: false } : props}
          row={row}
          settled={settled}
          handle={handle}
          arrived={arrived}
        />
      )}
      <Failure message={failed} />
    </div>
  )
}
