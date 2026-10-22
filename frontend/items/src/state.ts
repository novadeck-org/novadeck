import {
  kindRules,
  notesIn,
  planVersionOf,
  PlanUnwritableError,
  type Companions,
  type Item,
  type ItemContent,
  type ItemId,
  type PageTrouble,
  type PlanUnwritableReason,
  type PlanVersion,
} from "@novadeck/core/items"
import {
  createStore,
  type MutableStore,
  type Store,
  type WorkspaceStore,
} from "@novadeck/core/store"
import type { Workspace, WorkspaceTarget } from "@novadeck/core/types"

import { currentMarks, docOf, eolOf, lf, type Mark, type PlanDoc } from "./kinds/plan/plan-doc"

// What the items package holds while the app runs, apart from the items themselves and
// how bars are arranged, which the workspace store keeps: each plan as the person edits
// it, what each item last loaded, and which items that may hold secrets the person chose
// to see. Every plan is followed for as long as it exists; anything else only while
// something shows it. Components read it through ./use-item-store.ts.

export type ItemStoreState = {
  // Each plan once its first version came, by its item.
  readonly plans: Readonly<Record<ItemId, PlanDoc>>
  // What each item held when it last reported, a plan's too.
  readonly content: Readonly<Record<ItemId, ItemContent>>
  // Items that may hold secrets, which the person asked to see, each with what it pointed at
  // then. Pointed elsewhere since, the yes is no longer there: see `isRevealed`.
  readonly revealed: Readonly<Record<ItemId, string>>
}

const emptyState: ItemStoreState = { plans: {}, content: {}, revealed: {} }

// What can be done with a plan, apart from showing it.
export type PlanActions = {
  // The person edited it: the file changes, for the agent to read. `marks` are the latest
  // rewrite's highlights, moved along with the edit.
  readonly edit: (text: string, marks: readonly Mark[]) => void
  // The editor closed: notes left empty in the plan go, from the plan as it now stands,
  // and edits waiting for a pause in typing are saved.
  readonly closeEditor: () => void
  // Focus left the plan: what's waiting for a pause in typing is saved now, so an agent
  // told to re-read it finds it.
  readonly flush: () => void
  // The person asked to try saving again after saves stopped: they go on, and a plan
  // that can be written again is cleared of what stopped them.
  readonly retry: () => void
  readonly toggleChanges: () => void
}

export type ItemStore = {
  readonly store: Store<ItemStoreState>
  // Follows an item while something shows it; returns the release.
  readonly watch: (target: WorkspaceTarget, itemId: ItemId) => () => void
  // The person asked to see an item that may hold secrets.
  readonly reveal: (itemId: ItemId) => void
  readonly plan: (target: WorkspaceTarget, itemId: ItemId) => PlanActions
  // Tells what went wrong on a live page that show `shown` of the item loaded.
  readonly trouble: (
    target: WorkspaceTarget,
    itemId: ItemId,
    shown: number,
    troubles: readonly PageTrouble[],
  ) => void
  // Follows every plan in the workspace from here on; returns the stop.
  readonly connect: () => () => void
  // Takes a picture of a live page for it to rest as: the backend's, where it has one.
  readonly picture?: Companions["picture"]
}

type Followed = {
  readonly target: WorkspaceTarget
  reveal: boolean
  // What the item pointed at when it was followed, which following again follows when it
  // changes; undefined until the workspace shows the item.
  pointed?: string | undefined
  stop: () => void
  // How many places show it, and whether it's a plan, which is followed regardless.
  watchers: number
  plan: boolean
  // Once nothing shows it, the wait before it's let go.
  lingering?: ReturnType<typeof setTimeout> | undefined
}

type Session = {
  readonly companions: Companions
  readonly workspace: WorkspaceStore
  readonly store: MutableStore<ItemStoreState>
  readonly followed: Map<ItemId, Followed>
  // Per plan, the text of the save under way, and the one waiting for typing to pause.
  readonly saving: Map<ItemId, string>
  readonly waiting: Map<ItemId, ReturnType<typeof setTimeout>>
  // Per plan, a rewrite that came while a save was under way, applied once it answers:
  // until then the base it was written over isn't known.
  readonly pending: Map<ItemId, PlanVersion>
  // Per plan, how many saves in a row failed, which spaces out the next try.
  readonly failures: Map<ItemId, number>
  // Per plan, whether the wait before the next try of a failed save is running: edits and
  // focus changes leave it alone, so only tries it spaced out count toward the cap.
  readonly backingOff: Set<ItemId>
  // Per plan, texts sent in saves whose answer never came: the file may hold any of them.
  readonly unconfirmed: Map<ItemId, readonly string[]>
}

// Which file an item shows, for a file or an image, and what kind it is otherwise. The same
// item shown another file is something else to read, as the project window's is when the
// person opens another; any other change, as new lines or a new route, replaces content in place.
const pointedAt = (item: Pick<Item, "kind" | "path">): string =>
  JSON.stringify([item.kind, item.kind === "file" || item.kind === "image" ? item.path : null])

const pointedIn = (workspace: Workspace, id: ItemId): string | undefined => {
  for (const project of workspace.projects)
    for (const each of project.history) {
      const item = each.state.items.find((candidate) => candidate.id === id)
      if (item) return pointedAt(item)
    }
  return undefined
}

// Whether the person's yes to seeing an item still holds: it was to the file it pointed at
// then, so another file, whenever it came, is held back again.
const isRevealed = (session: Session, id: ItemId): boolean => {
  const asked = session.store.getSnapshot().revealed[id]
  return asked !== undefined && asked === pointedIn(session.workspace.getSnapshot(), id)
}

const planIn = (session: Session, id: ItemId): PlanDoc | undefined =>
  session.store.getSnapshot().plans[id]

// Changes a plan, if the pane holds it. The changed plan, or undefined when nothing changed.
const withPlan = (
  session: Session,
  id: ItemId,
  change: (plan: PlanDoc) => PlanDoc,
): PlanDoc | undefined => {
  let changed: PlanDoc | undefined
  session.store.update((state) => {
    const plan = state.plans[id]
    if (!plan) return state
    const next = change(plan)
    if (next === plan) return state
    changed = next
    return { ...state, plans: { ...state.plans, [id]: next } }
  })
  return changed
}

// How long what an item held stays once nothing shows it.
const lingerMs = 30_000

// Typing reaches the file once it pauses, not on every keystroke.
const typingPause = 400

const saveSoon = (session: Session, target: WorkspaceTarget, id: ItemId): void => {
  if (session.backingOff.has(id)) return
  clearTimeout(session.waiting.get(id))
  session.waiting.set(
    id,
    setTimeout(() => {
      session.waiting.delete(id)
      persist(session, target, id)
    }, typingPause),
  )
}

// Saves what's waiting at once, as when the editor closes.
const saveNow = (session: Session, target: WorkspaceTarget, id: ItemId): void => {
  // While a failed save waits to be tried again, only the wait's end tries it.
  if (!session.backingOff.has(id)) {
    clearTimeout(session.waiting.get(id))
    session.waiting.delete(id)
  }
  persist(session, target, id)
}

// How long a save may go unanswered before it counts as failed and is tried again.
const saveTimeout = 20_000

// How many saves in a row may fail before they stop until the person retries.
const failureCap = 5

// The person's edits reach the file one save at a time. A save the file refused, having
// changed since, merges like any rewrite, and what's left of the edits goes again. A
// save that failed is tried again, less often each time, and the plan says so, until
// `failureCap` fail in a row. One the backend says can never work, and one made while the
// plan's file is gone, stop at once. Either waits for the person to retry (`manual`).
const persist = (session: Session, target: WorkspaceTarget, id: ItemId, manual = false): void => {
  const plan = planIn(session, id)
  // A plan the backend can't write is never saved.
  if (session.saving.has(id) || !plan?.writable) return
  // Says how saving stands, changing the plan only if that's new.
  const stand = (flags: Pick<PlanDoc, "unsaved" | "blocked" | "stalled">): void => {
    withPlan(session, id, (current) =>
      current.unsaved === flags.unsaved &&
      current.blocked === flags.blocked &&
      current.stalled === flags.stalled
        ? current
        : { ...current, ...flags },
    )
  }
  // Nothing left to save, as when the person undid the edit or the agent wrote the same.
  if (plan.text === plan.base) {
    session.failures.delete(id)
    stand({ unsaved: false, blocked: null, stalled: false })
    return
  }
  const content = session.store.getSnapshot().content[id]
  const gone = content?.state === "unavailable" && content.reason === "gone"
  if (!manual && (plan.blocked || plan.stalled || gone || session.backingOff.has(id))) return
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
  // A rewrite that came meanwhile applies now, over the base the file still has.
  const applyPending = (): void => {
    const pending = session.pending.get(id)
    session.pending.delete(id)
    if (pending) void revise(session, target, id, pending)
  }
  // The backend said why it never will: nothing was written, and saves stop.
  const refused = (reason: PlanUnwritableReason): void => {
    // A file that is gone while the stream shows it, or a rewrite of it waiting, was put
    // back meanwhile: that's a failure that may pass, not a verdict.
    const shown = session.store.getSnapshot().content[id]?.state === "ready"
    if (reason === "gone" && (shown || session.pending.has(id))) return failed()
    if (!settleAttempt()) return
    session.failures.delete(id)
    clearTimeout(session.waiting.get(id))
    session.waiting.delete(id)
    stand({ unsaved: true, blocked: reason, stalled: false })
    applyPending()
  }
  const failed = (): void => {
    if (!settleAttempt()) return
    // It may have been written all the same: the next version of the file tells.
    session.unconfirmed.set(id, [...(session.unconfirmed.get(id) ?? []), sent])
    const failures = (session.failures.get(id) ?? 0) + 1
    session.failures.set(id, failures)
    const stalled = failures >= failureCap
    stand({ unsaved: true, blocked: null, stalled })
    applyPending()
    clearTimeout(session.waiting.get(id))
    if (stalled) {
      session.waiting.delete(id)
      session.backingOff.delete(id)
      return
    }
    session.backingOff.add(id)
    session.waiting.set(
      id,
      setTimeout(
        () => {
          session.waiting.delete(id)
          session.backingOff.delete(id)
          persist(session, target, id)
        },
        Math.min(30_000, 1000 * 2 ** failures),
      ),
    )
  }
  const timer = setTimeout(failed, saveTimeout)
  session.companions.save(target, id, text, basedOn).then(
    async (result) => {
      if (!settleAttempt()) return
      if (result.saved) session.unconfirmed.delete(id)
      session.failures.delete(id)
      stand({ unsaved: false, blocked: null, stalled: false })
      const pending = session.pending.get(id)
      session.pending.delete(id)
      if (result.saved) {
        withPlan(session, id, (current) =>
          current.revision === basedOn
            ? { ...current, base: sent, revision: result.stamp }
            : current,
        )
        // A rewrite that came meanwhile was written over this save.
        if (pending) await revise(session, target, id, pending)
      } else await revise(session, target, id, result.current)
      persist(session, target, id)
    },
    (error: unknown) => (error instanceof PlanUnwritableError ? refused(error.reason) : failed()),
  )
}

// The plan's file changed: the agent rewrote it over the file as the person left it. Its
// changes merge into the person's latest edits line by line, and notes it applied are
// gone. The merge code loads only when a plan changes, like the editor it shares.
const revise = async (
  session: Session,
  target: WorkspaceTarget,
  id: ItemId,
  version: PlanVersion,
): Promise<void> => {
  const { stamp, plan: incoming } = version
  const theirs = lf(incoming.text)
  const inFlight = session.saving.get(id)
  // A rewrite that isn't the save under way waits for its answer: it may have been
  // written over that save, which the plan's base doesn't hold yet.
  if (inFlight !== undefined && inFlight !== theirs) {
    session.pending.set(id, version)
    return
  }
  const { distance, merge } = await import("@novadeck/viewers/sync")
  const unconfirmed = session.unconfirmed.get(id) ?? []
  const echo = inFlight === theirs || unconfirmed.includes(theirs)
  withPlan(session, id, (plan) => {
    const facts = {
      writable: incoming.writable,
      skill: incoming.skill,
      truncated: incoming.truncated,
    }
    if (
      stamp === plan.revision &&
      theirs === plan.base &&
      incoming.writable === plan.writable &&
      incoming.skill === plan.skill &&
      incoming.truncated === plan.truncated
    )
      return plan
    // A backend watching the file reports the person's own save back.
    if (echo || theirs === plan.text)
      return { ...plan, ...facts, base: theirs, revision: stamp, eol: eolOf(incoming.text) }
    // A save whose answer never came may have been written: the rewrite merges over
    // whichever the file now stands closest to, so a written save's edits aren't
    // merged in twice and an unwritten one's aren't taken for the agent's.
    const base = [plan.base, ...unconfirmed].reduce((closest, candidate) =>
      distance(candidate, theirs) < distance(closest, theirs) ? candidate : closest,
    )
    const written = merge(base, plan.text, theirs)
    return {
      ...plan,
      ...facts,
      base: theirs,
      revision: stamp,
      eol: eolOf(incoming.text),
      text: written.text,
      marks: written.changed,
      marked: written.text,
      changes: written.changes,
      showChanges: true,
      resolved: Math.max(0, notesIn(plan.text) - notesIn(written.text)),
    }
  })
  // This version settles what the file holds; saves still unanswered no longer matter.
  session.unconfirmed.delete(id)
  persist(session, target, id)
}

// The item reported what it holds: a plan's first version becomes its document, and later
// ones merge into it.
const received = (
  session: Session,
  target: WorkspaceTarget,
  id: ItemId,
  content: ItemContent,
): void => {
  const version = planVersionOf(content)
  const known = planIn(session, id) !== undefined
  session.store.update((state) => {
    const first = version && !known
    if (state.content[id] === content && !first) return state
    return {
      ...state,
      content: { ...state.content, [id]: content },
      ...(first ? { plans: { ...state.plans, [id]: docOf(version) } } : {}),
    }
  })
  if (version && known) {
    // The file is back, or can be written again: what stopped saves no longer holds.
    // A fresh version also means the link is healthy: saves that gave up try again.
    if (planIn(session, id)?.stalled) session.failures.delete(id)
    withPlan(session, id, (plan) =>
      plan.blocked === "gone" || (plan.blocked === "transcript" && version.plan.writable)
        ? { ...plan, blocked: null, stalled: false }
        : plan.stalled
          ? { ...plan, stalled: false }
          : plan,
    )
    void revise(session, target, id, version)
  }
}

const follow = (
  session: Session,
  target: WorkspaceTarget,
  id: ItemId,
  from: Pick<Followed, "watchers" | "plan">,
): Followed => {
  const reveal = isRevealed(session, id)
  const entry: Followed = {
    target,
    reveal,
    pointed: pointedIn(session.workspace.getSnapshot(), id),
    stop: () => {},
    watchers: from.watchers,
    plan: from.plan,
  }
  // Known before following starts: the backend may report at once.
  session.followed.set(id, entry)
  listen(session, id, entry)
  return entry
}

// Starts what the backend reports for an item, as it's followed now. A report that
// comes after it stops, as one held back before the item was revealed, is let go.
const listen = (session: Session, id: ItemId, entry: Followed): void => {
  const { target, reveal } = entry
  let live = true
  const stop = session.companions.follow(target, id, { reveal }, (content) => {
    if (live && session.followed.get(id) === entry) received(session, target, id, content)
  })
  entry.stop = () => {
    live = false
    stop()
  }
}

// An item pointed elsewhere is followed again: what it held is dropped, and so is the
// person's yes to seeing it, which was to the file it pointed at then.
const refollow = (session: Session, id: ItemId, entry: Followed, pointed: string): void => {
  entry.stop()
  entry.reveal = false
  entry.pointed = pointed
  session.store.update((state) => {
    if (!(id in state.content) && !state.revealed[id]) return state
    const { [id]: _content, ...content } = state.content
    const { [id]: _revealed, ...revealed } = state.revealed
    return { ...state, content, revealed }
  })
  listen(session, id, entry)
}

const unfollow = (session: Session, id: ItemId): void => {
  const entry = session.followed.get(id)
  if (!entry) return
  session.followed.delete(id)
  clearTimeout(entry.lingering)
  entry.stop()
}

// Nothing shows it any more: what it last held goes, so a large image doesn't stay in
// memory. It loads again when something shows it.
const release = (session: Session, id: ItemId): void => {
  unfollow(session, id)
  session.store.update((state) => {
    if (!(id in state.content)) return state
    const { [id]: _gone, ...content } = state.content
    return { ...state, content }
  })
}

// Nothing shows it now: it goes after a while, so switching back to a terminal soon after
// finds it as it was, without loading it again.
const linger = (session: Session, id: ItemId, entry: Followed): void => {
  if (entry.watchers > 0 || entry.plan) return
  clearTimeout(entry.lingering)
  entry.lingering = setTimeout(() => {
    entry.lingering = undefined
    if (entry.watchers === 0 && !entry.plan && session.followed.get(id) === entry)
      release(session, id)
  }, lingerMs)
}

// A plan that's gone: its saves stop, and what they kept goes.
const forgetPlan = (session: Session, id: ItemId): void => {
  clearTimeout(session.waiting.get(id))
  for (const each of [
    session.saving,
    session.waiting,
    session.pending,
    session.failures,
    session.unconfirmed,
  ])
    each.delete(id)
  session.backingOff.delete(id)
}

// A record without the items that are gone.
const keep = <Value>(
  present: ReadonlyMap<ItemId, unknown>,
  record: Readonly<Record<ItemId, Value>>,
) => {
  const kept = Object.entries(record).filter(([id]) => present.has(id as ItemId))
  return kept.length === Object.keys(record).length
    ? record
    : (Object.fromEntries(kept) as Record<ItemId, Value>)
}

// Follows every plan in the workspace, stops following what's gone, and forgets it.
const reconcile = (session: Session, workspace: Workspace): void => {
  const present = new Map<
    ItemId,
    { readonly target: WorkspaceTarget; readonly plan: boolean; readonly pointed: string }
  >()
  for (const project of workspace.projects)
    for (const each of project.history)
      for (const item of each.state.items)
        present.set(item.id, {
          target: { projectId: project.id, workspaceSessionId: each.id },
          plan: kindRules[item.kind].follow === "always",
          pointed: pointedAt(item),
        })
  for (const [id, entry] of session.followed) {
    const found = present.get(id)
    if (!found) {
      unfollow(session, id)
      continue
    }
    if (entry.pointed === undefined) entry.pointed = found.pointed
    else if (entry.pointed !== found.pointed) refollow(session, id, entry, found.pointed)
    if (entry.plan && !found.plan) {
      entry.plan = false
      linger(session, id, entry)
    }
  }
  const planned = new Set([
    ...session.saving.keys(),
    ...session.waiting.keys(),
    ...session.pending.keys(),
    ...session.failures.keys(),
    ...session.unconfirmed.keys(),
  ])
  for (const id of planned) if (!present.has(id)) forgetPlan(session, id)
  for (const [id, { target, plan }] of present) {
    if (!plan) continue
    const entry = session.followed.get(id)
    if (entry) entry.plan = true
    else follow(session, target, id, { watchers: 0, plan: true })
  }
  session.store.update((state) => {
    const next = {
      plans: keep(present, state.plans),
      content: keep(present, state.content),
      revealed: keep(present, state.revealed),
    }
    return next.plans === state.plans &&
      next.content === state.content &&
      next.revealed === state.revealed
      ? state
      : next
  })
}

// Each session's items, which change far less often than the workspace.
const itemsOf = (workspace: Workspace) =>
  workspace.projects.flatMap((project) => project.history.map((each) => each.state.items))

export const createItemStore = ({
  companions,
  workspace,
}: {
  readonly companions: Companions
  readonly workspace: WorkspaceStore
}): ItemStore => {
  const session: Session = {
    companions,
    workspace,
    store: createStore<ItemStoreState>(emptyState),
    followed: new Map(),
    saving: new Map(),
    waiting: new Map(),
    pending: new Map(),
    failures: new Map(),
    backingOff: new Set(),
    unconfirmed: new Map(),
  }
  const watch = (target: WorkspaceTarget, id: ItemId): (() => void) => {
    const entry =
      session.followed.get(id) ?? follow(session, target, id, { watchers: 0, plan: false })
    clearTimeout(entry.lingering)
    entry.lingering = undefined
    entry.watchers += 1
    let released = false
    return () => {
      if (released) return
      released = true
      entry.watchers -= 1
      linger(session, id, entry)
    }
  }
  const reveal = (id: ItemId): void => {
    const pointed = pointedIn(session.workspace.getSnapshot(), id)
    // An item that's gone has nothing to show.
    if (pointed === undefined) return
    session.store.update((state) =>
      state.revealed[id] === pointed
        ? state
        : { ...state, revealed: { ...state.revealed, [id]: pointed } },
    )
    // The same entry follows it again, revealed, so the places showing it still let go
    // of it, and one waiting to be let go still is.
    const entry = session.followed.get(id)
    if (!entry || entry.reveal) return
    entry.stop()
    entry.reveal = true
    listen(session, id, entry)
  }
  const plan = (target: WorkspaceTarget, id: ItemId): PlanActions => ({
    edit: (text, marks) => {
      const edited = withPlan(session, id, (current) =>
        // A plan the backend can't write takes no edits. One that was too large may not
        // be, now.
        text === current.text || !current.writable || current.blocked === "transcript"
          ? current
          : {
              ...current,
              text,
              marks,
              marked: text,
              blocked: current.blocked === "too-large" ? null : current.blocked,
            },
      )
      if (edited) saveSoon(session, target, id)
    },
    closeEditor: () => {
      // The note code is already loaded: the editor that closed shares it.
      void import("./kinds/plan/plan-editor/notes").then(({ withoutEmptyNotes }) => {
        withPlan(session, id, (current) => {
          if (!current.writable) return current
          const kept = withoutEmptyNotes(current.text, currentMarks(current))
          return kept ? { ...current, ...kept, marked: kept.text } : current
        })
        saveNow(session, target, id)
      })
    },
    flush: () => saveNow(session, target, id),
    retry: () => {
      session.failures.delete(id)
      session.backingOff.delete(id)
      withPlan(session, id, (current) =>
        current.blocked || current.stalled
          ? { ...current, blocked: null, stalled: false }
          : current,
      )
      clearTimeout(session.waiting.get(id))
      session.waiting.delete(id)
      persist(session, target, id, true)
    },
    toggleChanges: () => {
      withPlan(session, id, (current) => ({ ...current, showChanges: !current.showChanges }))
    },
  })
  const connect = (): (() => void) => {
    reconcile(session, workspace.getSnapshot())
    // Items change far less often than the workspace: only a session's items changing
    // asks for a look.
    let seen = workspace.getSnapshot()
    const stopWorkspace = workspace.subscribe(() => {
      const next = workspace.getSnapshot()
      const before = itemsOf(seen)
      const after = itemsOf(next)
      seen = next
      if (before.length !== after.length || after.some((items, index) => items !== before[index]))
        reconcile(session, next)
    })
    return () => {
      stopWorkspace()
      for (const id of session.followed.keys()) unfollow(session, id)
    }
  }
  const { picture } = companions
  const trouble: ItemStore["trouble"] = (target, itemId, shown, troubles) =>
    session.companions.trouble(target, itemId, shown, troubles)
  return {
    store: session.store,
    watch,
    reveal,
    plan,
    trouble,
    connect,
    ...(picture && { picture }),
  }
}
