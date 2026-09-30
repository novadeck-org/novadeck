import { useEffect, useState, useSyncExternalStore } from "react"

import {
  companionKeyId,
  notesIn,
  type ArtifactContent,
  type CompanionKey,
  type CompanionSnapshot,
  type Companions,
  type PlanSnapshot,
} from "../../model/companion"
import { createStore, type MutableStore } from "../../model/store"
import type { ViewMode } from "../../model/types"
import {
  openCompanion,
  planRefOf,
  planTab,
  selectTab,
  show,
  type Companion,
  type Shown,
} from "./pane"

// Where the pane opens: beside the terminal inside its window, or hanging off a canvas
// node.
export type PlanPresentation = "split" | "attached"

// A stretch of the text the agent's latest revision wrote.
export type Mark = { readonly from: number; readonly to: number }

// A plan as the pane holds it.
export type PlanDoc = Omit<PlanSnapshot, "text" | "revision" | "truncated"> & {
  readonly truncated: boolean
  // The file as both sides last agreed on it, at `revision`: the agent's rewrites and
  // the user's edits merge against it.
  readonly base: string
  readonly revision: string
  // The file's line break, put back when saving. The editor and the merge work in LF.
  readonly eol: "\n" | "\r\n"
  // The file as the user sees it: `base` with their edits since.
  readonly text: string
  // How many times the agent rewrote it, and how many of those the user saw.
  readonly writes: number
  readonly seen: number
  // What the latest rewrite wrote, valid for `marked` (the text it produced).
  readonly marks: readonly Mark[]
  readonly marked: string
  readonly changes: number
  readonly showChanges: boolean
  // Notes the agent removed in its latest rewrite, having applied them.
  readonly resolved: number
  // The last save didn't reach the file; it's tried again.
  readonly unsaved: boolean
}

// A terminal's companion pane: its plans, the root one first, then what else its agent
// showed.
export type PaneState = Companion & {
  readonly key: CompanionKey
  readonly plans: readonly PlanDoc[]
}

const lf = (text: string): string => text.replace(/\r\n?/g, "\n")

// The file's line break: CRLF when every line ends so, LF otherwise.
const eolOf = (text: string): "\n" | "\r\n" => {
  const breaks = text.split("\n").length - 1
  return breaks > 0 && text.split("\r\n").length - 1 === breaks ? "\r\n" : "\n"
}

const docOf = (plan: PlanSnapshot): PlanDoc => ({
  ref: plan.ref,
  role: plan.role,
  path: plan.path,
  agent: plan.agent,
  skill: plan.skill,
  writable: plan.writable,
  truncated: Boolean(plan.truncated),
  base: lf(plan.text),
  revision: plan.revision,
  eol: eolOf(plan.text),
  text: lf(plan.text),
  writes: 0,
  seen: -1,
  marks: [],
  marked: "",
  changes: 0,
  showChanges: false,
  resolved: 0,
  unsaved: false,
})

// The root plan first, then subagents' plans in the order they came.
const ordered = (plans: readonly PlanDoc[]): readonly PlanDoc[] => [
  ...plans.filter((plan) => plan.role === "root"),
  ...plans.filter((plan) => plan.role !== "root"),
]

const homeOf = (plans: readonly PlanDoc[]): string => (plans[0] ? planTab(plans[0].ref) : "")

const paneOf = ({ key, plans, shown }: CompanionSnapshot): PaneState => {
  const docs = ordered(plans.map(docOf))
  return {
    key,
    plans: docs,
    open: false,
    tab: homeOf(docs),
    home: homeOf(docs),
    artifacts: shown.map((artifact): Shown => ({ ...artifact, fresh: false, at: "1 min ago" })),
  }
}

// Beside the terminal, or on the canvas, attached to the terminal's node.
export const presentationOf = (view: ViewMode): PlanPresentation =>
  view === "canvas" ? "attached" : "split"

// The latest rewrite's marks, while the text is still the one they describe.
export const currentMarks = (plan: PlanDoc): readonly Mark[] =>
  plan.marked === plan.text ? plan.marks : []

export const unread = (plan: PlanDoc): boolean => plan.seen < plan.writes

// What the pane shows: its tab, while that still exists, or else its home.
export const shownTab = (pane: PaneState): string => {
  const exists = (tab: string): boolean => {
    const ref = planRefOf(tab)
    return ref === null
      ? pane.artifacts.some((shown) => shown.id === tab)
      : pane.plans.some((plan) => plan.ref === ref)
  }
  return exists(pane.tab) ? pane.tab : exists(pane.home) ? pane.home : (pane.artifacts[0]?.id ?? "")
}

const reading = (pane: PaneState, ref: string): boolean =>
  pane.open && shownTab(pane) === planTab(ref)

const withPlan = (pane: PaneState, ref: string, change: (plan: PlanDoc) => PlanDoc): PaneState => {
  let changed = false
  const plans = pane.plans.map((plan) => {
    if (plan.ref !== ref) return plan
    const next = change(plan)
    changed ||= next !== plan
    return next
  })
  return changed ? { ...pane, plans } : pane
}

// Reading a plan's tab counts as reading its latest rewrite.
const markRead = (pane: PaneState): PaneState => {
  const ref = pane.open ? planRefOf(shownTab(pane)) : null
  return ref === null
    ? pane
    : withPlan(pane, ref, (plan) =>
        plan.seen === plan.writes ? plan : { ...plan, seen: plan.writes },
      )
}

// Opening the pane goes to what's new.
export const openPane = (pane: PaneState): PaneState => markRead(openCompanion(pane))

// Opening the pane to a chosen tab.
export const openTab = (pane: PaneState, tab: string): PaneState => markRead(selectTab(pane, tab))

export const closePane = (pane: PaneState): PaneState => ({ ...pane, open: false })

export const toggleChanges = (pane: PaneState, ref: string): PaneState =>
  withPlan(pane, ref, (plan) => ({ ...plan, showChanges: !plan.showChanges }))

type Panes = MutableStore<Readonly<Record<string, PaneState>>>

// What the pane keeps per backend: the panes, the saves under way, and loaded content.
type Session = {
  readonly companions: Companions
  readonly panes: Panes
  // Per plan, the text of the save under way, and the one waiting for typing to pause.
  readonly saving: Map<string, string>
  readonly waiting: Map<string, ReturnType<typeof setTimeout>>
  // Per plan, a rewrite that came while a save was under way, applied once it answers:
  // until then the base it was written over isn't known.
  readonly pending: Map<string, PlanSnapshot>
  // Per plan, how many saves in a row failed, which spaces out the next try.
  readonly failures: Map<string, number>
  // Per plan, texts sent in saves whose answer never came: the file may hold any of them.
  readonly unconfirmed: Map<string, readonly string[]>
  readonly content: Map<string, Promise<ArtifactContent>>
  // A pane for each terminal that has none yet, the same one each time it's asked for.
  readonly empty: Map<string, PaneState>
}

const emptyPane = (session: Session, key: CompanionKey): PaneState => {
  const id = companionKeyId(key)
  const pane = session.empty.get(id) ?? paneOf({ key, plans: [], shown: [] })
  session.empty.set(id, pane)
  return pane
}

const planId = (key: CompanionKey, ref: string): string => `${companionKeyId(key)}#${ref}`

const change = (
  session: Session,
  key: CompanionKey,
  update: (pane: PaneState) => PaneState,
): PaneState | undefined => {
  let changed: PaneState | undefined
  const id = companionKeyId(key)
  session.panes.update((current) => {
    const pane = current[id]
    if (!pane) return current
    const updated = update(pane)
    // A pane left with nothing to show closes, so nothing reopens it on its own later.
    const next =
      updated.open && !updated.plans.length && !updated.artifacts.length
        ? { ...updated, open: false }
        : updated
    if (next === pane) return current
    changed = next
    return { ...current, [id]: next }
  })
  return changed
}

const planIn = (session: Session, key: CompanionKey, ref: string): PlanDoc | undefined =>
  session.panes.getSnapshot()[companionKeyId(key)]?.plans.find((plan) => plan.ref === ref)

// Typing reaches the file once it pauses, not on every keystroke.
const typingPause = 400

const saveSoon = (session: Session, key: CompanionKey, ref: string): void => {
  const id = planId(key, ref)
  clearTimeout(session.waiting.get(id))
  session.waiting.set(
    id,
    setTimeout(() => {
      session.waiting.delete(id)
      persist(session, key, ref)
    }, typingPause),
  )
}

// Saves what's waiting at once, as when the editor closes.
const saveNow = (session: Session, key: CompanionKey, ref: string): void => {
  const id = planId(key, ref)
  clearTimeout(session.waiting.get(id))
  session.waiting.delete(id)
  persist(session, key, ref)
}

// The user's edits reach the file one save at a time. A save the file refused, having
// changed since, merges like any rewrite, and what's left of the edits goes again. A
// save that failed is tried again, less often each time, and the plan says so.
// How long a save may go unanswered before it counts as failed and is tried again.
const saveTimeout = 20_000

const persist = (session: Session, key: CompanionKey, ref: string): void => {
  const id = planId(key, ref)
  const plan = planIn(session, key, ref)
  // A plan the backend can't write is never saved.
  if (session.saving.has(id) || !plan?.writable) return
  const mark = (unsaved: boolean): void => {
    change(session, key, (pane) =>
      withPlan(pane, ref, (current) =>
        current.unsaved === unsaved ? current : { ...current, unsaved },
      ),
    )
  }
  // Nothing left to save, as when the user undid the edit or the agent wrote the same.
  if (plan.text === plan.base) {
    session.failures.delete(id)
    if (plan.unsaved) mark(false)
    return
  }
  const sent = plan.text
  const basedOn = plan.revision
  session.saving.set(id, sent)
  const text = plan.eol === "\n" ? sent : sent.replaceAll("\n", plan.eol)
  // Only this attempt's answer counts: one that comes after it timed out is ignored.
  let answered = false
  const settleAttempt = (): boolean => {
    if (answered) return false
    answered = true
    clearTimeout(timer)
    session.saving.delete(id)
    return true
  }
  const failed = (): void => {
    if (!settleAttempt()) return
    // It may have been written all the same: the next version of the file tells.
    session.unconfirmed.set(id, [...(session.unconfirmed.get(id) ?? []), sent])
    const failures = (session.failures.get(id) ?? 0) + 1
    session.failures.set(id, failures)
    mark(true)
    // A rewrite that came meanwhile applies now, over the base the file still has.
    const pending = session.pending.get(id)
    session.pending.delete(id)
    if (pending) void revise(session, key, pending)
    clearTimeout(session.waiting.get(id))
    session.waiting.set(
      id,
      setTimeout(
        () => {
          session.waiting.delete(id)
          persist(session, key, ref)
        },
        Math.min(30_000, 1000 * 2 ** failures),
      ),
    )
  }
  const timer = setTimeout(failed, saveTimeout)
  session.companions.save(key, ref, text, basedOn).then(async (result) => {
    if (!settleAttempt()) return
    if (result.saved) session.unconfirmed.delete(id)
    session.failures.delete(id)
    mark(false)
    const pending = session.pending.get(id)
    session.pending.delete(id)
    if (result.saved) {
      change(session, key, (pane) =>
        withPlan(pane, ref, (current) =>
          current.revision === basedOn
            ? { ...current, base: sent, revision: result.revision }
            : current,
        ),
      )
      // A rewrite that came meanwhile was written over this save.
      if (pending) await revise(session, key, pending)
    } else await revise(session, key, result.current)
    persist(session, key, ref)
  }, failed)
}

// The plan's file changed: the agent rewrote it over the file as the user left it. Its
// changes merge into the user's latest edits line by line, and notes it applied are
// gone. The merge code loads only when a plan changes, like the editor it shares.
const revise = async (
  session: Session,
  key: CompanionKey,
  snapshot: PlanSnapshot,
): Promise<void> => {
  const id = planId(key, snapshot.ref)
  const theirs = lf(snapshot.text)
  const inFlight = session.saving.get(id)
  // A rewrite that isn't the save under way waits for its answer: it may have been
  // written over that save, which the plan's base doesn't hold yet.
  if (inFlight !== undefined && inFlight !== theirs) {
    session.pending.set(id, snapshot)
    return
  }
  const { distance, merge } = await import("./plan-editor/sync")
  const unconfirmed = session.unconfirmed.get(id) ?? []
  const echo = inFlight === theirs || unconfirmed.includes(theirs)
  change(session, key, (pane) =>
    withPlan(pane, snapshot.ref, (plan) => {
      if (
        snapshot.revision === plan.revision &&
        theirs === plan.base &&
        snapshot.writable === plan.writable &&
        Boolean(snapshot.truncated) === plan.truncated
      )
        return plan
      // A backend watching the file reports the user's own save back.
      if (echo || theirs === plan.text)
        return {
          ...plan,
          writable: snapshot.writable,
          truncated: Boolean(snapshot.truncated),
          base: theirs,
          revision: snapshot.revision,
          eol: eolOf(snapshot.text),
        }
      // A save whose answer never came may have been written: the rewrite merges over
      // whichever the file now stands closest to, so a written save's edits aren't
      // merged in twice and an unwritten one's aren't taken for the agent's.
      const base = [plan.base, ...unconfirmed].reduce((closest, candidate) =>
        distance(candidate, theirs) < distance(closest, theirs) ? candidate : closest,
      )
      const written = merge(base, plan.text, theirs)
      const writes = plan.writes + 1
      return {
        ...plan,
        writable: snapshot.writable,
        truncated: Boolean(snapshot.truncated),
        base: theirs,
        revision: snapshot.revision,
        eol: eolOf(snapshot.text),
        text: written.text,
        writes,
        seen: reading(pane, plan.ref) ? writes : plan.seen,
        marks: written.marks,
        marked: written.text,
        changes: written.changes,
        showChanges: true,
        resolved: Math.max(0, notesIn(plan.text) - notesIn(written.text)),
      }
    }),
  )
  // This version settles what the file holds; saves still unanswered no longer matter.
  session.unconfirmed.delete(id)
  persist(session, key, snapshot.ref)
}

const sessions = new WeakMap<Companions, Session>()

// One session per backend's companions, following their events for as long as the
// backend lives. Its snapshot holds what came before.
const sessionOf = (companions: Companions): Session => {
  const existing = sessions.get(companions)
  if (existing) return existing
  const panes: Panes = createStore(
    Object.fromEntries(
      companions.snapshot().map((snapshot) => [companionKeyId(snapshot.key), paneOf(snapshot)]),
    ),
  )
  const session: Session = {
    companions,
    panes,
    saving: new Map(),
    waiting: new Map(),
    pending: new Map(),
    failures: new Map(),
    unconfirmed: new Map(),
    content: new Map(),
    empty: new Map(),
  }
  // Something arrived for a terminal that had nothing to show yet.
  const ensure = (key: CompanionKey): void => {
    panes.update((current) =>
      current[companionKeyId(key)]
        ? current
        : { ...current, [companionKeyId(key)]: emptyPane(session, key) },
    )
  }
  companions.subscribe((event) => {
    const id = companionKeyId(event.key)
    if (event.type === "companion/closed") {
      panes.update(({ [id]: _closed, ...rest }) => rest)
      return
    }
    ensure(event.key)
    if (event.type === "artifact/shown") {
      change(session, event.key, (pane) => markRead(show(pane, event.artifact, event.asked)))
      return
    }
    if (event.type === "plan/removed") {
      change(session, event.key, (pane) => {
        const plans = pane.plans.filter((plan) => plan.ref !== event.ref)
        return { ...pane, plans, home: homeOf(plans) }
      })
      return
    }
    const known = planIn(session, event.key, event.plan.ref)
    if (known) void revise(session, event.key, event.plan)
    else
      change(session, event.key, (pane) => {
        const plans = ordered([...pane.plans, docOf(event.plan)])
        return { ...pane, plans, home: homeOf(plans), tab: pane.tab || homeOf(plans) }
      })
  })
  sessions.set(companions, session)
  return session
}

// A terminal's pane as its components use it.
export type CompanionHandle = {
  readonly pane: PaneState
  // Whether there's anything to show: a plan, or something the agent showed.
  readonly present: boolean
  readonly update: (update: (pane: PaneState) => PaneState) => void
  // The user edited a plan: the file changes, for the agent to read. `marks` are the
  // latest rewrite's highlights, moved along with the edit.
  readonly edit: (ref: string, text: string, marks: readonly Mark[]) => void
  // The editor closed: notes left empty in the plan go, from the plan as it now stands,
  // and edits waiting for a pause in typing are saved.
  readonly closeEditor: (ref: string) => void
  // Focus left the plan: what's waiting for a pause in typing is saved now, so an agent
  // told to re-read it finds it.
  readonly flush: (ref: string) => void
  readonly load: (artifact: Shown) => Promise<ArtifactContent>
}

// What can be done with a terminal's pane, apart from rendering it.
export type CompanionActions = Omit<CompanionHandle, "pane" | "present"> & {
  readonly current: () => PaneState
}

export const companionActions = (companions: Companions, key: CompanionKey): CompanionActions => {
  const session = sessionOf(companions)
  const id = companionKeyId(key)
  return {
    current: () => session.panes.getSnapshot()[id] ?? emptyPane(session, key),
    update: (update) => {
      change(session, key, update)
    },
    edit: (ref, text, marks) => {
      const edited = change(session, key, (current) =>
        withPlan(current, ref, (plan) =>
          // A plan the backend can't write takes no edits.
          text === plan.text || !plan.writable ? plan : { ...plan, text, marks, marked: text },
        ),
      )
      if (edited) saveSoon(session, key, ref)
    },
    closeEditor: (ref) => {
      // The note code is already loaded: the editor that closed shares it.
      void import("./plan-editor/notes").then(({ withoutEmptyNotes }) => {
        change(session, key, (current) =>
          withPlan(current, ref, (plan) => {
            if (!plan.writable) return plan
            const kept = withoutEmptyNotes(plan.text, currentMarks(plan))
            return kept ? { ...plan, ...kept, marked: kept.text } : plan
          }),
        )
        saveNow(session, key, ref)
      })
    },
    flush: (ref) => saveNow(session, key, ref),
    load: (artifact) => {
      const cached = `${id}/${artifact.id}@${artifact.version}`
      const known = session.content.get(cached)
      if (known) return known
      const loading = companions.load(key, artifact.id)
      session.content.set(cached, loading)
      // A load that failed is tried again the next time the artifact is opened.
      loading.catch(() => session.content.delete(cached))
      return loading
    },
  }
}

export const useCompanion = (companions: Companions, key: CompanionKey): CompanionHandle => {
  const { panes } = sessionOf(companions)
  const actions = companionActions(companions, key)
  const pane = useSyncExternalStore(panes.subscribe, actions.current)
  return {
    ...actions,
    pane,
    present: pane.plans.length > 0 || pane.artifacts.length > 0,
  }
}

export type ArtifactLoad =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly content: ArtifactContent }
  | { readonly status: "failed" }

// An artifact's content, loading on first use.
export const useArtifactContent = (companion: CompanionHandle, artifact: Shown): ArtifactLoad => {
  const [load, setLoad] = useState<{ readonly for: string; readonly state: ArtifactLoad }>({
    for: "",
    state: { status: "loading" },
  })
  const which = `${artifact.id}@${artifact.version}`
  const { load: fetch } = companion
  useEffect(() => {
    let current = true
    fetch(artifact).then(
      (content) => current && setLoad({ for: which, state: { status: "ready", content } }),
      () => current && setLoad({ for: which, state: { status: "failed" } }),
    )
    return () => {
      current = false
    }
    // The artifact's identity and version decide what loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [which])
  return load.for === which ? load.state : { status: "loading" }
}
