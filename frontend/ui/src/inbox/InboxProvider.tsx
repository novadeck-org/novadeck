import type { Picks } from "@novadeck/core/answers"
import type { Inbox, InboxAnswer, InboxItem, InboxState } from "@novadeck/core/inbox"
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
export type Sent = { readonly item: InboxItem; readonly note: string }

// What the person has started to answer with and not sent: their words, the option they
// picked on an agent's own ask, and the picks on a dialog's questions.
export type Draft = {
  readonly text: string
  readonly option: number | null
  readonly picks: Picks | null
}
export const noDraft: Draft = { text: "", option: null, picks: null }

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
  readonly shown: readonly InboxItem[]
  readonly held: readonly InboxItem[]
  readonly view: InboxView
  readonly now: number
  // The item whose sheet is open: as the backend has it, or, once answered, as it was.
  readonly current: InboxItem | undefined
  readonly sent: Readonly<Record<string, Sent>>
  readonly drafts: Readonly<Record<string, Draft>>
  // Items answered and dropped by the backend that keep their row, answered, until the
  // sheet closes.
  readonly ghosts: Readonly<Record<string, InboxItem>>
  // Whether the Inbox is on a screen of its own, where the list and a sheet each take it.
  readonly phone: boolean
  // Whether any agent in the workspace is at work, which the empty list says.
  readonly working: boolean
  readonly open: (id: string) => void
  readonly close: () => void
  readonly showHeld: () => void
  readonly next: () => void
  readonly setDraft: (id: string, patch: Partial<Draft>) => void
  readonly submit: (item: InboxItem, answer: InboxAnswer, note: string) => void
  // Changes how an item is handled without answering it, as turning auto-resume on or off.
  readonly change: (item: InboxItem, answer: InboxAnswer) => void
  readonly readAll: () => void
  readonly reveal: (item: InboxItem) => void
}

const InboxContext = createContext<InboxContextValue | null>(null)

// Opens the item `pick` finds among those listed now, for a view outside the Inbox: one
// function for as long as the Inbox lasts, so a view holding it never renders again with
// the Inbox's every change. None in a view rendered on its own.
export type InboxOpener = (pick: (items: readonly InboxItem[]) => InboxItem | undefined) => void

const OpenerContext = createContext<InboxOpener | null>(null)

export const useInboxOpener = (): InboxOpener | null => useContext(OpenerContext)

export const useInboxContext = (): InboxContextValue => {
  const value = useContext(InboxContext)
  if (!value) throw new Error("useInboxContext must be used inside an InboxProvider")
  return value
}

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
  children,
}: {
  readonly inbox: Inbox
  // Shows the terminal an item is from.
  readonly reveal: (terminalId: string) => void
  // Present where the Inbox has a screen of its own at a time.
  readonly phone?: Phone | undefined
  // Whether any agent in the workspace is at work.
  readonly working?: boolean
  readonly children?: ReactNode
}): React.JSX.Element => {
  const state = useSyncExternalStore(inbox.state.subscribe, inbox.state.getSnapshot)
  const [view, setView] = useState<InboxView>(initialView)
  const [answered, setAnswered] = useState<Readonly<Record<string, Sent>>>({})
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({})
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), tickMs)
    return () => window.clearInterval(timer)
  }, [])

  // With no sheet open, new items join the list; the ones that do are marked a moment.
  const settled = settle(view, state.items)
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
  const current =
    state.items.find(({ id }) => id === view.open) ??
    (view.open === null ? undefined : sent[view.open]?.item)

  const dropSent = useCallback((id: string | null): void => {
    if (id !== null)
      setAnswered((record) =>
        id in record
          ? Object.fromEntries(Object.entries(record).filter(([key]) => key !== id))
          : record,
      )
  }, [])

  const open = useCallback(
    (id: string): void => {
      const { state: snapshot, view: before, phone: screen } = latest.current
      if (before.open !== id) dropSent(before.open)
      setView(openItem(before, id, snapshot.items))
      const found = snapshot.items.find((item) => item.id === id)
      if (found && !found.seen) inbox.see(id)
      if (before.open === null) screen?.hideList()
    },
    [inbox, dropSent],
  )

  const close = useCallback((): void => {
    const { state: snapshot, view: before, phone: screen } = latest.current
    if (before.open === null) return
    dropSent(before.open)
    setView(closeSheet(before, snapshot.items))
    screen?.showList()
  }, [dropSent])

  const showHeld = useCallback((): void => {
    const { state: snapshot, view: before } = latest.current
    setView(release(before, snapshot.items))
  }, [])

  const next = useCallback((): void => {
    const { state: snapshot, view: before } = latest.current
    const target = nextItem(snapshot.items, before.open, snapshot)
    dropSent(before.open)
    if (!target) return close()
    setView(openItem(release(before, snapshot.items), target.id, snapshot.items))
    if (!target.seen) inbox.see(target.id)
  }, [inbox, dropSent, close])

  const setDraft = useCallback((id: string, patch: Partial<Draft>): void => {
    setDrafts((record) => {
      const merged = { ...(record[id] ?? noDraft), ...patch }
      const { [id]: _gone, ...rest } = record
      return started(merged) ? { ...rest, [id]: merged } : rest
    })
  }, [])

  const submit = useCallback(
    (item: InboxItem, answer: InboxAnswer, note: string): void => {
      setAnswered((record) => ({ ...record, [item.id]: { item, note } }))
      inbox.answer(item.id, answer)
    },
    [inbox],
  )

  const change = useCallback(
    (item: InboxItem, answer: InboxAnswer): void => inbox.answer(item.id, answer),
    [inbox],
  )

  const readAll = useCallback((): void => {
    const { state: snapshot, view: before } = latest.current
    const opened = snapshot.items.find(({ id }) => id === before.open)
    inbox.readAll()
    if (opened?.kind === "update") close()
  }, [inbox, close])

  const revealItem = useCallback(
    (item: InboxItem): void => {
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
        visible(live, snapshot.items, dropped),
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
      sent,
      drafts,
      ghosts,
      phone: phone !== undefined,
      working,
      open,
      close,
      showHeld,
      next,
      setDraft,
      submit,
      change,
      readAll,
      reveal: revealItem,
    }),
    [
      state,
      shown,
      heldItems,
      view,
      now,
      current,
      sent,
      drafts,
      ghosts,
      phone,
      working,
      open,
      close,
      showHeld,
      next,
      setDraft,
      submit,
      change,
      readAll,
      revealItem,
    ],
  )
  const opener = useCallback<InboxOpener>(
    (pick) => {
      const found = pick(latest.current.state.items)
      if (found) open(found.id)
    },
    [open],
  )
  return (
    <OpenerContext.Provider value={opener}>
      <InboxContext.Provider value={value}>{children}</InboxContext.Provider>
    </OpenerContext.Provider>
  )
}
