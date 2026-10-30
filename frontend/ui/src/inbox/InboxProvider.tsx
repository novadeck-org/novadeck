import type { Picks } from "@novadeck/core/conversation/picks"
import type { Inbox, InboxAnswer, InboxRow, InboxState } from "@novadeck/core/inbox"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import { rowOf } from "./inbox-dom"
import {
  clearArrived,
  closeSheet,
  held,
  informing,
  initialView,
  nextItem,
  openItem,
  release,
  settle,
  stepFrom,
  visible,
  type InboxView,
} from "./inbox-state"

// An answer the person gave, kept with its item and what it did, so the sheet can say so
// after the backend drops the item.
export type Sent = { readonly item: InboxRow; readonly note: string }

// The line the next sheet opens with once an answer has taken: what it did, said with the
// agent's handle (`note`), for the item `from`.
export type Receipt = { readonly from: string; readonly note: string }

// What the person has started to answer with and not sent: their words, the option they
// picked on an agent's own ask, and the picks on a dialog's questions, with the questions
// (of several picks) whose written words are unticked: kept, but left out of the answer.
export type Draft = {
  readonly text: string
  readonly option: number | null
  readonly picks: Picks | null
  readonly leftOut: readonly string[]
}
export const noDraft: Draft = { text: "", option: null, picks: null, leftOut: [] }

// Whether there is anything in a draft worth a "Draft" on the row.
export const started = (draft: Draft | undefined): boolean =>
  draft !== undefined &&
  (draft.text.trim() !== "" ||
    draft.option !== null ||
    Object.values(draft.picks ?? {}).some(
      (pick) => pick.options.length > 0 || pick.text.trim() !== "",
    ))

export type InboxContextValue = {
  readonly state: InboxState
  // The items the list shows, and those held back while a sheet is open.
  readonly shown: readonly InboxRow[]
  readonly held: readonly InboxRow[]
  readonly view: InboxView
  readonly now: number
  // The item whose sheet is open: as the backend has it (settled, where it settled while
  // open), or, once answered, as it was.
  readonly current: InboxRow | undefined
  // What the last answer did, which the sheet it moved on to says.
  readonly receipt: Receipt | null
  readonly sent: Readonly<Record<string, Sent>>
  readonly drafts: Readonly<Record<string, Draft>>
  // Items answered and dropped by the backend that keep their row, answered, until the
  // sheet closes.
  readonly ghosts: Readonly<Record<string, InboxRow>>
  // Whether the Inbox is on a screen of its own, where the list and a sheet each take it.
  readonly phone: boolean
  // Whether any agent in the workspace is at work, which the empty list says.
  readonly working: boolean
  readonly open: (id: string) => void
  readonly close: () => void
  readonly showHeld: () => void
  readonly setDraft: (id: string, patch: Partial<Draft>) => void
  readonly submit: (item: InboxRow, answer: InboxAnswer, note: string) => void
  // Changes how an item is handled without answering it, as turning auto-resume on or off.
  readonly change: (item: InboxRow, answer: InboxAnswer) => void
  readonly readAll: () => void
  // Dismisses an open ask, and clears the settled ones; absent where the backend has no such.
  readonly dismiss: ((id: string) => void) | undefined
  readonly clear: (() => void) | undefined
  readonly reveal: (item: InboxRow) => void
}

const InboxContext = createContext<InboxContextValue | null>(null)

// Opens the item `pick` finds among those listed now, for a view outside the Inbox: one
// function for as long as the Inbox lasts, so a view holding it never renders again with
// the Inbox's every change. None in a view rendered on its own.
export type InboxOpener = (pick: (items: readonly InboxRow[]) => InboxRow | undefined) => void

const OpenerContext = createContext<InboxOpener | null>(null)

export const useInboxOpener = (): InboxOpener | null => useContext(OpenerContext)

export const useInboxContext = (): InboxContextValue => {
  const value = useContext(InboxContext)
  if (!value) throw new Error("useInboxContext must be used inside an InboxProvider")
  return value
}

// An answer's item, by id and when it started waiting: a newer item may take an old id.
const answerKey = (item: InboxRow): string => `${item.id}@${item.at}`

// How long a freshly arrived item stays marked, and how often waits are read again.
const arrivedMs = 1700
const tickMs = 30_000

const editable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  Boolean(target.closest("input, textarea, select, [contenteditable='true']"))

type Phone = {
  // Takes the list off the screen for a sheet, and brings it back.
  readonly hideList: () => void
  readonly showList: () => void
}

export const InboxProvider = ({
  inbox,
  reveal,
  phone,
  working = false,
  active = false,
  children,
}: {
  readonly inbox: Inbox
  // Shows the terminal an item is from.
  readonly reveal: (terminalId: string) => void
  // Present where the Inbox has a screen of its own at a time.
  readonly phone?: Phone | undefined
  // Whether any agent in the workspace is at work.
  readonly working?: boolean
  // Whether the Inbox's panel is on screen: the asks that settle meanwhile keep their place.
  readonly active?: boolean
  readonly children?: ReactNode
}): React.JSX.Element => {
  const state = useSyncExternalStore(inbox.state.subscribe, inbox.state.getSnapshot)
  const [view, setView] = useState<InboxView>(initialView)
  const [answered, setAnswered] = useState<Readonly<Record<string, Sent>>>({})
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  // The answers the sheet has moved on from, by item id and when it started waiting (a newer
  // item may take an old id): opened again, their sheet stays, answered.
  const movedOn = useRef(new Set<string>())
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({})
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), tickMs)
    return () => window.clearInterval(timer)
  }, [])

  // With no sheet open, new items join the list; the ones that do are marked a moment.
  const settled = settle(view, state.items, active)
  if (settled !== view) setView(settled)
  useEffect(() => {
    if (view.arrived.length === 0) return
    const timer = window.setTimeout(() => setView(clearArrived), arrivedMs)
    return () => window.clearTimeout(timer)
  }, [view.arrived])

  // An answer is no answer to a newer item that has taken its id.
  const sent = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(answered).filter(([id, answer]) => {
          const live = state.items.find((item) => item.id === id)
          return live === undefined || live.at === answer.item.at
        }),
      ),
    [answered, state.items],
  )
  const ghosts = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(sent)
          .filter(([id]) => !state.items.some((item) => item.id === id))
          .map(([id, answer]) => [id, answer.item]),
      ),
    [sent, state.items],
  )
  // A draft for an item that is gone, and not shown answered, is dropped.
  const gone = Object.keys(drafts).filter(
    (id) => !(id in ghosts) && !state.items.some((item) => item.id === id),
  )
  if (gone.length > 0)
    setDrafts((record) =>
      Object.fromEntries(Object.entries(record).filter(([id]) => !gone.includes(id))),
    )
  const shown = useMemo(() => visible(view, state.items, ghosts), [view, state.items, ghosts])

  // What the handlers below read, as of the last commit.
  const latest = useRef({ state, view, phone, ghosts })
  useLayoutEffect(() => {
    latest.current = { state, view, phone, ghosts }
  })
  const heldItems = useMemo(() => held(view, state.items), [view, state.items])
  // An ask that settles while its sheet is open stays open, settled, to say so; one settled
  // before opens no sheet (`open`).
  const standing = state.items.find(({ id }) => id === view.open)
  const current = standing ?? (view.open === null ? undefined : sent[view.open]?.item)

  const open = useCallback(
    // `items` where the caller read them newer than the last commit.
    (id: string, items?: readonly InboxRow[]): void => {
      const { state: snapshot, view: before, phone: screen } = latest.current
      const list = items ?? snapshot.items
      const found = list.find((item) => item.id === id)
      // A settled ask has no sheet.
      if (found?.settled) return
      // Answered rows keep their place, and their answers, until the sheet closes.
      if (before.open !== id) setReceipt(null)
      setView(openItem(before, id, list))
      if (found && !found.seen) inbox.see(id)
      if (before.open === null) screen?.hideList()
    },
    [inbox],
  )

  // Closing forgets every answer the sheet moved on from: their rows go with it.
  const close = useCallback((): void => {
    const { state: snapshot, view: before, phone: screen } = latest.current
    if (before.open === null) return
    setAnswered({})
    setReceipt(null)
    movedOn.current.clear()
    setView(closeSheet(before, snapshot.items))
    screen?.showList()
  }, [])

  const showHeld = useCallback((): void => {
    const { state: snapshot, view: before } = latest.current
    setView(release(before, snapshot.items))
  }, [])

  // Once an answer has taken, on to what asks next, with the receipt; with nothing left, the
  // sheet closes. The answered row keeps its place, answered, until it does.
  const moveOn = useCallback(
    (from: InboxRow, note: string): void => {
      const { state: snapshot, view: before } = latest.current
      if (before.open !== from.id || movedOn.current.has(answerKey(from))) return
      movedOn.current.add(answerKey(from))
      const target = nextItem(snapshot.items, from.id, snapshot)
      if (!target) return close()
      setReceipt({ from: from.id, note })
      // The list stays as it is, the answered row in it, unless what is next has yet to join.
      const kept = before.order.includes(target.id) ? before : release(before, snapshot.items)
      setView(openItem(kept, target.id, snapshot.items))
      if (!target.seen) inbox.see(target.id)
      // Its row comes into view, for the sheet to sit beside.
      requestAnimationFrame(() => rowOf(target.id)?.scrollIntoView?.({ block: "nearest" }))
    },
    [inbox, close],
  )
  const done =
    view.open !== null &&
    sent[view.open] !== undefined &&
    !state.answering[view.open] &&
    state.failed[view.open] === undefined &&
    !state.items.some(({ id }) => id === view.open)
      ? sent[view.open]
      : undefined
  useEffect(() => {
    if (done) moveOn(done.item, done.note)
  }, [done, moveOn])

  const setDraft = useCallback((id: string, patch: Partial<Draft>): void => {
    setDrafts((record) => {
      const merged = { ...(record[id] ?? noDraft), ...patch }
      const { [id]: _gone, ...rest } = record
      return started(merged) ? { ...rest, [id]: merged } : rest
    })
  }, [])

  const submit = useCallback(
    (item: InboxRow, answer: InboxAnswer, note: string): void => {
      setAnswered((record) => ({ ...record, [item.id]: { item, note } }))
      inbox.answer(item.id, answer)
    },
    [inbox],
  )

  const change = useCallback(
    (item: InboxRow, answer: InboxAnswer): void => inbox.answer(item.id, answer),
    [inbox],
  )

  const readAll = useCallback((): void => {
    const { state: snapshot, view: before } = latest.current
    const opened = snapshot.items.find(({ id }) => id === before.open)
    inbox.readAll()
    if (opened?.kind === "update" || (opened && informing(opened))) close()
  }, [inbox, close])

  const dismiss = useMemo(
    () => (inbox.dismiss ? (id: string): void => inbox.dismiss?.(id) : undefined),
    [inbox],
  )
  const clear = useMemo(
    () =>
      inbox.clear
        ? (): void =>
            inbox.clear?.(
              latest.current.state.items.filter((item) => item.settled).map(({ id }) => id),
            )
        : undefined,
    [inbox],
  )

  const revealItem = useCallback(
    (item: InboxRow): void => {
      close()
      reveal(item.source.terminalId)
    },
    [close, reveal],
  )

  // An open sheet whose item is gone without an answer of the person's closes with it.
  useEffect(() => {
    if (view.open !== null && !current) close()
  }, [view.open, current, close])

  // Esc closes the sheet; in one of its fields it first leaves the field (or, in one that
  // cancels, cancels). j and k move down and up the list. Only where the keys are the
  // Inbox's: on its list, its sheet, or no field at all; every other layer keeps its own.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key !== "Escape" && event.key !== "j" && event.key !== "k") return
      const target = event.target
      const ours =
        target === document ||
        target === document.body ||
        target === document.documentElement ||
        (target instanceof Element &&
          target.closest(".inbox-sheet, #inbox-panel, .inbox-fullscreen") !== null)
      if (!ours) return
      const { view: live, state: snapshot, ghosts: dropped } = latest.current
      if (event.key === "Escape") {
        if (live.open === null) return
        if (editable(target) && target instanceof HTMLElement) {
          if (target.closest("[data-cancels]")) return
          target.blur()
          return
        }
        event.preventDefault()
        close()
        return
      }
      if (editable(target)) return
      const inSheet = target instanceof Element && target.closest(".inbox-sheet, .inbox-fullscreen")
      const inList = target instanceof Element && target.closest("#inbox-panel") !== null
      if (live.open === null && !inList) return
      if (!inSheet && !inList && target !== document.body && target !== document) return
      const to = stepFrom(
        visible(live, snapshot.items, dropped).filter(
          (item) => !item.settled || item.id === live.open,
        ),
        live.open,
        event.key === "j" ? 1 : -1,
      )
      if (!to) return
      event.preventDefault()
      // A row that is gone, answered, is stepped from where it was.
      if (to.id !== live.open) open(to.id)
      // The keyboard goes with it, so the row it is on is the one that shows it.
      rowOf(to.id)?.querySelector<HTMLElement>(".inbox-row-select")?.focus()
    }
    // In capture, ahead of the sheet's own layer, which takes Escape's default for itself.
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [open, close])

  const value = useMemo<InboxContextValue>(
    () => ({
      state,
      shown,
      held: heldItems,
      view,
      now,
      current,
      receipt,
      sent,
      drafts,
      ghosts,
      phone: phone !== undefined,
      working,
      open,
      close,
      showHeld,
      setDraft,
      submit,
      change,
      readAll,
      dismiss,
      clear,
      reveal: revealItem,
    }),
    [
      state,
      shown,
      heldItems,
      view,
      now,
      current,
      receipt,
      sent,
      drafts,
      ghosts,
      phone,
      working,
      open,
      close,
      showHeld,
      setDraft,
      submit,
      change,
      readAll,
      dismiss,
      clear,
      revealItem,
    ],
  )
  const opener = useCallback<InboxOpener>(
    (pick) => {
      // The Inbox as it is now: an item just revealed is there before the next commit.
      const items = inbox.state.getSnapshot().items
      const found = pick(items)
      if (found) open(found.id, items)
    },
    [open, inbox],
  )
  return (
    <OpenerContext.Provider value={opener}>
      <InboxContext.Provider value={value}>{children}</InboxContext.Provider>
    </OpenerContext.Provider>
  )
}
