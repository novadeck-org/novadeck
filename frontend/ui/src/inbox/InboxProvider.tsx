import {
  entryKey,
  type Inbox,
  type InboxAnswer,
  type InboxEntry,
  type InboxState,
} from "@novadeck/core/inbox"
import { drafted, untouched, type DialogDraft } from "@novadeck/requests/drafts"
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

import { focusSheetSoon, rowOf } from "./inbox-dom"
import {
  clearArrived,
  closeSheet,
  held,
  asks,
  initialView,
  keptOrder,
  nextEntry,
  openEntry,
  rearranged,
  release,
  settle,
  stepFrom,
  visible,
  type InboxView,
} from "./inbox-state"
import { useReadOnLeaving } from "./read-on-leaving"

// An answer the person gave, kept with its entry and what it did, so the sheet can say so
// after the backend drops the entry.
export type Sent = { readonly entry: InboxEntry; readonly note: string }

// The line the next sheet opens with once an answer has taken: what it did, said with the
// agent's handle (`note`), for the entry `from`.
export type Receipt = { readonly from: string; readonly note: string }

// What the person has started to answer with and not sent: their words to an agent's own ask,
// the option they picked on it, and what they put into a request's dialog (its card's draft:
// words typed into its options, picks on its questions and the page they're on, a form's
// entries).
export type Draft = {
  readonly text: string
  readonly option: number | null
  readonly request: DialogDraft | null
}
export const noDraft: Draft = { text: "", option: null, request: null }

// Whether there is anything in a draft worth a "Draft" on the entry.
export const started = (draft: Draft | undefined): boolean =>
  draft !== undefined &&
  (draft.text.trim() !== "" || draft.option !== null || drafted(draft.request ?? undefined))

export type InboxContextValue = {
  readonly state: InboxState
  // The entries the list shows, and those held back while a sheet is open.
  readonly shown: readonly InboxEntry[]
  readonly held: readonly InboxEntry[]
  readonly view: InboxView
  readonly now: number
  // The entry whose sheet is open: as the backend has it (resolved, where it resolved while
  // open), or, once answered and dropped, as it was.
  readonly current: InboxEntry | undefined
  // What the last answer did, which the sheet it moved on to says.
  readonly receipt: Receipt | null
  readonly sent: Readonly<Record<string, Sent>>
  // The drafts, by `entryKey`: a newer entry under the same id is another ask, with none yet.
  readonly drafts: Readonly<Record<string, Draft>>
  // Entries answered and dropped by the backend that keep their entry, answered, until the
  // sheet closes (the backend lists most as resolved instead).
  readonly ghosts: Readonly<Record<string, InboxEntry>>
  // Whether the Inbox is on a screen of its own, where the list and a sheet each take it.
  readonly phone: boolean
  // Whether any agent in the workspace is at work, which the empty list says.
  readonly working: boolean
  // Whether the Inbox's panel is on screen, where an update's entry can be seen.
  readonly active: boolean
  // Whether the person looks at the page: it has their focus and no dialog covers it.
  readonly looking: boolean
  // Notes an update's entry as seen in the list: it is read once the person leaves the list.
  readonly sighted: (entry: InboxEntry) => void
  // Opens an entry's sheet; with `once`, for that entry alone (see `OpenOptions`).
  readonly open: (id: string, options?: OpenOptions) => void
  readonly close: () => void
  readonly showHeld: () => void
  readonly setDraft: (key: string, patch: Partial<Draft>) => void
  readonly submit: (entry: InboxEntry, answer: InboxAnswer, note: string) => void
  // Changes how an entry is handled without answering it, as turning auto-resume on or off.
  readonly change: (entry: InboxEntry, answer: InboxAnswer) => void
  // Dismisses an open ask; absent where the backend has no such.
  readonly dismiss: ((id: string) => void) | undefined
  // Keeps the entries that ask in the order the person dragged them into; absent where the
  // backend keeps no order, and the entries can't be dragged.
  readonly arrange: ((entries: readonly InboxEntry[]) => void) | undefined
  // Snoozes an entry (`on`) or brings it back; snoozed from its open sheet, the next that asks
  // opens, as after an answer. Absent where the backend keeps no snoozes.
  readonly snooze: ((entry: InboxEntry, on: boolean) => void) | undefined
  readonly reveal: (entry: InboxEntry) => void
}

// How a sheet opens.
//
// A sheet opened `once` with an `after`, while no sheet is open, is a one-off: once its entry
// is answered, snoozed from it, or gone, or the person closes it after it resolved, the
// sheet closes instead of going on to what asks next, and `after` runs. Another `once` open
// while a one-off is open is one too, with the first one's `after`. Any other open, or
// closing it before then, makes it an ordinary sheet, and `after` never runs.
export type OpenOptions = {
  // Opens the sheet in this window even for an entry whose project another window shows, which
  // `routeAway` would give to that window: this window is the one that was handed it.
  readonly here?: boolean
  // The entries, where the caller read them newer than the last commit.
  readonly entries?: readonly InboxEntry[]
  // For its entry alone, as a click on a toast or a notice opens it.
  readonly once?: boolean
  // Puts back what the Inbox took the place of; absent where the Inbox showed already.
  readonly after?: (() => void) | undefined
}

const InboxContext = createContext<InboxContextValue | null>(null)

// Opens the entry `pick` finds among those listed now, for a view outside the Inbox: one
// function for as long as the Inbox lasts, so a view holding it never renders again with
// the Inbox's every change. None in a view rendered on its own.
// Given `once`, it opens for its entry alone, with `once.after` (see `OpenOptions`).
export type InboxOpener = (
  pick: (entries: readonly InboxEntry[]) => InboxEntry | undefined,
  once?: { readonly after: (() => void) | undefined },
  options?: { readonly here?: boolean },
) => void

const OpenerContext = createContext<InboxOpener | null>(null)

export const useInboxOpener = (): InboxOpener | null => useContext(OpenerContext)

export const useInboxContext = (): InboxContextValue => {
  const value = useContext(InboxContext)
  if (!value) throw new Error("useInboxContext must be used inside an InboxProvider")
  return value
}

// An answer's entry, by id and when it started waiting: a newer entry may take an old id.
const answerKey = (entry: InboxEntry): string => `${entry.id}@${entry.at}`

// How long a freshly arrived entry stays marked, and how often waits are read again.
const arrivedMs = 1700
const tickMs = 30_000

const noOrder: readonly string[] = []
const noOrderStore = { subscribe: () => () => {}, getSnapshot: () => noOrder }

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
  routeAway,
  phone,
  working = false,
  active = false,
  looking = false,
  children,
}: {
  readonly inbox: Inbox
  // Shows the terminal an entry is from.
  readonly reveal: (terminalId: string) => void
  // Gives an entry to another window where one shows its project, which then opens its sheet
  // (`OpenOptions.here`); true when it did, and the sheet doesn't open here.
  readonly routeAway?: ((entry: InboxEntry) => boolean) | undefined
  // Present where the Inbox has a screen of its own at a time.
  readonly phone?: Phone | undefined
  // Whether any agent in the workspace is at work.
  readonly working?: boolean
  // Whether the Inbox's panel is on screen: the asks that settle meanwhile keep their place.
  readonly active?: boolean
  // Whether the person looks at the page: it has their focus and no dialog covers it.
  readonly looking?: boolean
  readonly children?: ReactNode
}): React.JSX.Element => {
  const state = useSyncExternalStore(inbox.state.subscribe, inbox.state.getSnapshot)
  const orderStore = inbox.order ?? noOrderStore
  const arranged = useSyncExternalStore(orderStore.subscribe, orderStore.getSnapshot)
  const [view, setView] = useState<InboxView>(initialView)
  const [answered, setAnswered] = useState<Readonly<Record<string, Sent>>>({})
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  // The answers the sheet has moved on from, by entry id and when it started waiting (a newer
  // entry may take an old id): opened again, their sheet stays, answered.
  const movedOn = useRef(new Set<string>())
  // The entry whose sheet is open as a one-off, and what runs once it is done with (see
  // `OpenOptions`).
  const oneOff = useRef<{ readonly id: string; readonly after: () => void } | null>(null)
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({})
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), tickMs)
    return () => window.clearInterval(timer)
  }, [])

  // With no sheet open, new entries join the list; the ones that do are marked a moment.
  const settled = settle(view, state.items, active)
  if (settled !== view) setView(settled)
  useEffect(() => {
    if (view.arrived.length === 0) return
    const timer = window.setTimeout(() => setView(clearArrived), arrivedMs)
    return () => window.clearTimeout(timer)
  }, [view.arrived])

  // An answer is no answer to a newer entry that has taken its id.
  const sent = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(answered).filter(([id, answer]) => {
          const live = state.items.find((entry) => entry.id === id)
          return live === undefined || live.at === answer.entry.at
        }),
      ),
    [answered, state.items],
  )
  const ghosts = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(sent)
          .filter(([id]) => !state.items.some((entry) => entry.id === id))
          .map(([id, answer]) => [id, answer.entry]),
      ),
    [sent, state.items],
  )
  // A draft for an entry that is gone, and not shown answered, is dropped.
  const gone = Object.keys(drafts).filter(
    (key) =>
      !Object.values(ghosts).some((entry) => entryKey(entry) === key) &&
      !state.items.some((entry) => entryKey(entry) === key),
  )
  if (gone.length > 0)
    setDrafts((record) =>
      Object.fromEntries(Object.entries(record).filter(([key]) => !gone.includes(key))),
    )
  const shown = useMemo(
    () => visible(view, state.items, ghosts, arranged),
    [view, state.items, ghosts, arranged],
  )

  // What the handlers below read, as of the last commit.
  const latest = useRef({
    state,
    view,
    phone,
    ghosts,
    arranged,
    snoozing: undefined as ((entry: InboxEntry, on: boolean) => void) | undefined,
  })
  useLayoutEffect(() => {
    latest.current = { ...latest.current, state, view, phone, ghosts, arranged }
  })
  const heldEntries = useMemo(() => held(view, state.items), [view, state.items])
  // An ask that settles while its sheet is open stays open, settled, to say so; one settled
  // before opens no sheet (`open`).
  const standing = state.items.find(({ id }) => id === view.open)
  const current = standing ?? (view.open === null ? undefined : sent[view.open]?.entry)

  const open = useCallback(
    (id: string, { entries, once = false, after, here = false }: OpenOptions = {}): void => {
      const { state: snapshot, view: before, phone: screen, arranged: order } = latest.current
      const list = entries ?? snapshot.items
      const found = list.find((entry) => entry.id === id)
      // Handed to another window, this one stays as it was, a peek at the Inbox put back.
      if (found && !here && routeAway?.(found)) return after?.()
      const kept = once
        ? (oneOff.current?.after ?? (before.open === null ? after : undefined))
        : undefined
      if (kept) oneOff.current = { id, after: kept }
      else if (oneOff.current?.id !== id) oneOff.current = null
      // Answered entries keep their place, and their answers, until the sheet closes.
      if (before.open !== id) setReceipt(null)
      setView(openEntry(before, id, list, order))
      if (found && !found.seen) inbox.see(id)
      // Opening an update reads it: it stays, resolved, as history.
      if (found?.kind === "update" && !found.settled)
        inbox.answer(id, { kind: "update", action: "read" })
      if (before.open === null) screen?.hideList()
    },
    [inbox, routeAway],
  )

  // Closing forgets every answer the sheet moved on from: their entries go with it.
  const close = useCallback((): void => {
    const { state: snapshot, view: before, phone: screen } = latest.current
    if (before.open === null) return
    const once = oneOff.current
    oneOff.current = null
    setAnswered({})
    setReceipt(null)
    movedOn.current.clear()
    setView(closeSheet(before, snapshot.items))
    screen?.showList()
    // A one-off whose entry resolved while it was open, as an ask replied to in its terminal, is
    // done with as well.
    const settledOpen = snapshot.items.find(({ id }) => id === before.open)?.settled
    if (once?.id === before.open && settledOpen) once.after()
  }, [])

  const showHeld = useCallback((): void => {
    const { state: snapshot, view: before, arranged: order } = latest.current
    setView(release(before, snapshot.items, order))
  }, [])

  // Once an answer has taken, on to what asks next, with the receipt; with nothing left, the
  // sheet closes. The answered entry keeps its place, answered, until it does.
  const moveOn = useCallback(
    (from: InboxEntry, note: string): void => {
      const { state: snapshot, view: before, arranged: order } = latest.current
      if (before.open !== from.id || movedOn.current.has(answerKey(from))) return
      movedOn.current.add(answerKey(from))
      // A one-off goes on to nothing: it closes, and gives back what it took the place of.
      const once = oneOff.current
      if (once?.id === from.id) {
        close()
        return once.after()
      }
      const target = nextEntry(snapshot.items, from.id, snapshot, order)
      if (!target) return close()
      setReceipt({ from: from.id, note })
      // The list stays as it is, the answered entry in it, unless what is next has yet to join.
      const kept = before.order.includes(target.id)
        ? before
        : release(before, snapshot.items, order)
      setView(openEntry(kept, target.id, snapshot.items, order))
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
    !state.items.some((each) => each.id === view.open && !each.settled)
      ? sent[view.open]
      : undefined
  useEffect(() => {
    if (done) moveOn(done.entry, done.note)
  }, [done, moveOn])

  const setDraft = useCallback((key: string, patch: Partial<Draft>): void => {
    setDrafts((record) => {
      const merged = { ...(record[key] ?? noDraft), ...patch }
      const { [key]: _gone, ...rest } = record
      // A dialog's draft is kept while it holds anything at all (a space typed first, the page
      // a dialog of questions is on), though only words, picks and entries make it a Draft.
      return started(merged) || !untouched(merged.request) ? { ...rest, [key]: merged } : rest
    })
  }, [])

  const submit = useCallback(
    (entry: InboxEntry, answer: InboxAnswer, note: string): void => {
      setAnswered((record) => ({ ...record, [entry.id]: { entry, note } }))
      inbox.answer(entry.id, answer)
    },
    [inbox],
  )

  const change = useCallback(
    (entry: InboxEntry, answer: InboxAnswer): void => inbox.answer(entry.id, answer),
    [inbox],
  )

  // The updates seen in the list are read as the person leaves it: the panel goes, or they
  // stop looking at the page. One opened meanwhile is read already, and one whose read is on
  // its way or failed isn't read again.
  const noteSeen = useReadOnLeaving(active && looking, (keys) => {
    const snapshot = inbox.state.getSnapshot()
    for (const entry of snapshot.items)
      if (
        keys.has(entryKey(entry)) &&
        entry.kind === "update" &&
        !entry.settled &&
        !snapshot.answering[entry.id] &&
        snapshot.failed[entry.id] === undefined
      )
        inbox.answer(entry.id, { kind: "update", action: "read" })
  })
  const sighted = useCallback((entry: InboxEntry): void => noteSeen(entryKey(entry)), [noteSeen])

  const dismiss = useMemo(
    () => (inbox.dismiss ? (id: string): void => inbox.dismiss?.(id) : undefined),
    [inbox],
  )

  const arrange = useMemo(
    () =>
      inbox.arrange
        ? (entries: readonly InboxEntry[]): void => {
            inbox.arrange?.(keptOrder(latest.current.arranged, entries.map(entryKey)))
            setView((before) =>
              rearranged(
                before,
                entries.map(({ id }) => id),
              ),
            )
          }
        : undefined,
    [inbox],
  )

  const snooze = useMemo(
    () =>
      inbox.snooze
        ? (entry: InboxEntry, on: boolean): void => {
            const { view: before, arranged: order } = latest.current
            inbox.snooze?.(entry.id, on)
            if (!on || before.open !== entry.id) return
            const once = oneOff.current
            if (once?.id === entry.id) {
              close()
              return once.after()
            }
            const snapshot = inbox.state.getSnapshot()
            const target = nextEntry(snapshot.items, entry.id, snapshot, order)
            // With nothing left, the keyboard goes back to the snoozed row.
            if (!target) {
              close()
              requestAnimationFrame(() =>
                rowOf(entry.id)?.querySelector<HTMLElement>(".inbox-row-select")?.focus(),
              )
              return
            }
            setReceipt(null)
            const kept = before.order.includes(target.id)
              ? before
              : release(before, snapshot.items, order)
            setView(openEntry(kept, target.id, snapshot.items, order))
            if (!target.seen) inbox.see(target.id)
            requestAnimationFrame(() => rowOf(target.id)?.scrollIntoView?.({ block: "nearest" }))
            // The keyboard goes on to the next sheet, as from its row.
            focusSheetSoon()
          }
        : undefined,
    [inbox, close],
  )

  useLayoutEffect(() => {
    latest.current.snoozing = snooze
  }, [snooze])

  const revealEntry = useCallback(
    (entry: InboxEntry): void => {
      close()
      reveal(entry.source.terminalId)
    },
    [close, reveal],
  )

  // An open sheet whose entry is gone without an answer of the person's closes with it.
  // A one-off's goes back to what the Inbox took the place of, as after an answer.
  useEffect(() => {
    if (view.open === null || current) return
    const once = oneOff.current
    close()
    if (once?.id === view.open) once.after()
  }, [view.open, current, close])

  // Esc closes the sheet; in one of its fields it first leaves the field (or, in one that
  // cancels, cancels). j and k move down and up the list; with a sheet open, the right and
  // left arrows do too from the sheet, which keeps the keyboard (on the list's row the right
  // arrow goes into the sheet). Only where the keys are the Inbox's: on its list, its sheet,
  // or no field at all; every other layer keeps its own.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const arrow = event.key === "ArrowRight" || event.key === "ArrowLeft"
      const sleep = event.key === "s" || event.key === "S"
      if ((arrow || sleep) && event.shiftKey) return
      if (event.key !== "Escape" && event.key !== "j" && event.key !== "k" && !arrow && !sleep)
        return
      const target = event.target
      const ours =
        target === document ||
        target === document.body ||
        target === document.documentElement ||
        (target instanceof Element &&
          target.closest(".inbox-sheet, #inbox-panel, .inbox-fullscreen") !== null)
      if (!ours) return
      const { view: live, state: snapshot, ghosts: dropped, arranged: order } = latest.current
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
      if (arrow && (live.open === null || inList)) return
      // S in the open sheet snoozes its entry, or brings it back; on a row, the row does.
      if (sleep) {
        const entry = snapshot.items.find(({ id }) => id === live.open)
        if (inList || !entry || !asks(entry) || snapshot.answering[entry.id]) return
        if (!latest.current.snoozing) return
        event.preventDefault()
        latest.current.snoozing(entry, !entry.snoozed)
        return
      }
      const to = stepFrom(
        // Resolved and snoozed entries are stepped past.
        visible(live, snapshot.items, dropped, order).filter(
          (entry) => (!entry.settled && !entry.snoozed) || entry.id === live.open,
        ),
        live.open,
        event.key === "j" || event.key === "ArrowRight" ? 1 : -1,
      )
      if (!to) return
      event.preventDefault()
      // An entry that is gone, answered, is stepped from where it was.
      if (to.id !== live.open) open(to.id)
      // The keyboard goes with it: to the next sheet, after an arrow, so the next goes on from
      // there; else to the row, so the row it is on is the one that shows it.
      if (arrow) focusSheetSoon()
      else rowOf(to.id)?.querySelector<HTMLElement>(".inbox-row-select")?.focus()
    }
    // In capture, ahead of the sheet's own layer, which takes Escape's default for itself.
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [open, close])

  const value = useMemo<InboxContextValue>(
    () => ({
      state,
      shown,
      held: heldEntries,
      view,
      now,
      current,
      receipt,
      sent,
      drafts,
      ghosts,
      phone: phone !== undefined,
      working,
      active,
      looking,
      sighted,
      open,
      close,
      showHeld,
      setDraft,
      submit,
      change,
      dismiss,
      arrange,
      snooze,
      reveal: revealEntry,
    }),
    [
      state,
      shown,
      heldEntries,
      view,
      now,
      current,
      receipt,
      sent,
      drafts,
      ghosts,
      phone,
      working,
      active,
      looking,
      sighted,
      open,
      close,
      showHeld,
      setDraft,
      submit,
      change,
      dismiss,
      arrange,
      snooze,
      revealEntry,
    ],
  )
  const opener = useCallback<InboxOpener>(
    (pick, once, options) => {
      // The Inbox as it is now: an entry just revealed is there before the next commit.
      const entries = inbox.state.getSnapshot().items
      const found = pick(entries)
      const here = options?.here === true
      if (found)
        open(found.id, once ? { entries, once: true, after: once.after, here } : { entries, here })
    },
    [open, inbox],
  )
  return (
    <OpenerContext.Provider value={opener}>
      <InboxContext.Provider value={value}>{children}</InboxContext.Provider>
    </OpenerContext.Provider>
  )
}
