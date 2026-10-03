import {
  companionKeyOf,
  notesIn,
  planVersionOf,
  type Companions,
  type ItemContent,
  type ItemId,
  type PlanVersion,
} from "../../model/companion"
import { messagesKey } from "../../model/companion-bar"
import { hasMail, type MailState, type Messages, type TerminalMail } from "../../model/messages"
import type { WorkspaceAction } from "../../model/state"
import { createStore, type MutableStore, type Store, type WorkspaceStore } from "../../model/store"
import type { ViewMode, Workspace, WorkspaceTarget } from "../../model/types"
import { currentMarks, docOf, eolOf, lf, type Mark, type PlanDoc } from "./plan-doc"

// What the companion panes hold while the app runs, apart from the items themselves and
// how bars are arranged, which the workspace store keeps: each plan as the person edits
// it, what each item last loaded, and which items that may hold secrets the person chose
// to see. Every plan is followed for as long as it exists; anything else only while
// something shows it. Components read it through ./use-panes.ts.

// Where the pane opens: beside the terminal inside its window, or hanging off a canvas
// node.
export type PlanPresentation = "split" | "attached"

// Beside the terminal, or on the canvas, attached to the terminal's node.
export const presentationOf = (view: ViewMode): PlanPresentation =>
  view === "canvas" ? "attached" : "split"

export type PaneState = {
  // Each plan once its first version came, by its item.
  readonly plans: Readonly<Record<ItemId, PlanDoc>>
  // What each item held when it last reported, a plan's too.
  readonly content: Readonly<Record<ItemId, ItemContent>>
  // Items that may hold secrets, which the person asked to see.
  readonly revealed: Readonly<Record<ItemId, true>>
}

const emptyState: PaneState = { plans: {}, content: {}, revealed: {} }

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
  readonly toggleChanges: () => void
}

export type Panes = {
  readonly store: Store<PaneState>
  // Follows an item while something shows it; returns the release.
  readonly watch: (target: WorkspaceTarget, itemId: ItemId) => () => void
  // The person asked to see an item that may hold secrets.
  readonly reveal: (target: WorkspaceTarget, itemId: ItemId) => void
  readonly plan: (target: WorkspaceTarget, itemId: ItemId) => PlanActions
  // Follows every plan in the workspace and the messages from here on; returns the stop.
  readonly connect: () => () => void
}

type Followed = {
  readonly target: WorkspaceTarget
  readonly reveal: boolean
  stop: () => void
  // How many places show it, and whether it's a plan, which is followed regardless.
  watchers: number
  plan: boolean
}

type Session = {
  readonly companions: Companions
  readonly workspace: WorkspaceStore
  readonly panes: MutableStore<PaneState>
  readonly followed: Map<ItemId, Followed>
  // Per plan, the text of the save under way, and the one waiting for typing to pause.
  readonly saving: Map<ItemId, string>
  readonly waiting: Map<ItemId, ReturnType<typeof setTimeout>>
  // Per plan, a rewrite that came while a save was under way, applied once it answers:
  // until then the base it was written over isn't known.
  readonly pending: Map<ItemId, PlanVersion>
  // Per plan, how many saves in a row failed, which spaces out the next try.
  readonly failures: Map<ItemId, number>
  // Per plan, texts sent in saves whose answer never came: the file may hold any of them.
  readonly unconfirmed: Map<ItemId, readonly string[]>
}

const planIn = (session: Session, id: ItemId): PlanDoc | undefined =>
  session.panes.getSnapshot().plans[id]

// Changes a plan, if the pane holds it. The changed plan, or undefined when nothing changed.
const withPlan = (
  session: Session,
  id: ItemId,
  change: (plan: PlanDoc) => PlanDoc,
): PlanDoc | undefined => {
  let changed: PlanDoc | undefined
  session.panes.update((state) => {
    const plan = state.plans[id]
    if (!plan) return state
    const next = change(plan)
    if (next === plan) return state
    changed = next
    return { ...state, plans: { ...state.plans, [id]: next } }
  })
  return changed
}

// Typing reaches the file once it pauses, not on every keystroke.
const typingPause = 400

const saveSoon = (session: Session, target: WorkspaceTarget, id: ItemId): void => {
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
  clearTimeout(session.waiting.get(id))
  session.waiting.delete(id)
  persist(session, target, id)
}

// How long a save may go unanswered before it counts as failed and is tried again.
const saveTimeout = 20_000

// The person's edits reach the file one save at a time. A save the file refused, having
// changed since, merges like any rewrite, and what's left of the edits goes again. A
// save that failed is tried again, less often each time, and the plan says so.
const persist = (session: Session, target: WorkspaceTarget, id: ItemId): void => {
  const plan = planIn(session, id)
  // A plan the backend can't write is never saved.
  if (session.saving.has(id) || !plan?.writable) return
  const mark = (unsaved: boolean): void => {
    withPlan(session, id, (current) =>
      current.unsaved === unsaved ? current : { ...current, unsaved },
    )
  }
  // Nothing left to save, as when the person undid the edit or the agent wrote the same.
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
    if (pending) void revise(session, target, id, pending)
    clearTimeout(session.waiting.get(id))
    session.waiting.set(
      id,
      setTimeout(
        () => {
          session.waiting.delete(id)
          persist(session, target, id)
        },
        Math.min(30_000, 1000 * 2 ** failures),
      ),
    )
  }
  const timer = setTimeout(failed, saveTimeout)
  session.companions.save(target, id, text, basedOn).then(async (result) => {
    if (!settleAttempt()) return
    if (result.saved) session.unconfirmed.delete(id)
    session.failures.delete(id)
    mark(false)
    const pending = session.pending.get(id)
    session.pending.delete(id)
    if (result.saved) {
      withPlan(session, id, (current) =>
        current.revision === basedOn ? { ...current, base: sent, revision: result.stamp } : current,
      )
      // A rewrite that came meanwhile was written over this save.
      if (pending) await revise(session, target, id, pending)
    } else await revise(session, target, id, result.current)
    persist(session, target, id)
  }, failed)
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
  const { distance, merge } = await import("./plan-editor/sync")
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
      marks: written.marks,
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
  session.panes.update((state) => {
    const first = version && !known
    if (state.content[id] === content && !first) return state
    return {
      ...state,
      content: { ...state.content, [id]: content },
      ...(first ? { plans: { ...state.plans, [id]: docOf(version) } } : {}),
    }
  })
  if (version && known) void revise(session, target, id, version)
}

const follow = (
  session: Session,
  target: WorkspaceTarget,
  id: ItemId,
  from: Pick<Followed, "watchers" | "plan">,
): Followed => {
  const reveal = Boolean(session.panes.getSnapshot().revealed[id])
  const entry: Followed = {
    target,
    reveal,
    stop: () => {},
    watchers: from.watchers,
    plan: from.plan,
  }
  // Known before following starts: the backend may report at once.
  session.followed.set(id, entry)
  entry.stop = session.companions.follow(target, id, { reveal }, (content) => {
    if (session.followed.get(id) === entry) received(session, target, id, content)
  })
  return entry
}

const unfollow = (session: Session, id: ItemId): void => {
  const entry = session.followed.get(id)
  if (!entry) return
  session.followed.delete(id)
  entry.stop()
}

// Nothing shows it any more: what it last held goes, so a large image doesn't stay in
// memory. It loads again when something shows it.
const release = (session: Session, id: ItemId): void => {
  unfollow(session, id)
  session.panes.update((state) => {
    if (!(id in state.content)) return state
    const { [id]: _gone, ...content } = state.content
    return { ...state, content }
  })
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
}

// Follows every plan in the workspace, stops following what's gone, and forgets it.
const reconcile = (session: Session, workspace: Workspace): void => {
  const present = new Map<ItemId, { readonly target: WorkspaceTarget; readonly plan: boolean }>()
  for (const project of workspace.projects)
    for (const each of project.history)
      for (const item of each.state.items)
        present.set(item.id, {
          target: { projectId: project.id, workspaceSessionId: each.id },
          plan: item.kind === "plan",
        })
  for (const [id, entry] of session.followed) {
    const found = present.get(id)
    if (!found) unfollow(session, id)
    else if (entry.plan && !found.plan) {
      entry.plan = false
      if (entry.watchers === 0) release(session, id)
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
  session.panes.update((state) => {
    const keep = <Value>(record: Readonly<Record<ItemId, Value>>) => {
      const kept = Object.entries(record).filter(([id]) => present.has(id as ItemId))
      return kept.length === Object.keys(record).length
        ? record
        : (Object.fromEntries(kept) as Record<ItemId, Value>)
    }
    const next = {
      plans: keep(state.plans),
      content: keep(state.content),
      revealed: keep(state.revealed),
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

// How many messages a terminal's threads hold.
const messageCount = (mail: TerminalMail | undefined): number =>
  (mail?.threads ?? []).reduce((count, thread) => count + thread.messages.length, 0)

// The messages join a terminal's bar when it first has them, after what came before, and
// come back once hidden with the next message, whether or not the terminal is on screen.
const mailFollower = (session: Session) => {
  const counts = new Map<string, number>()
  return (state: MailState): void => {
    const actions: WorkspaceAction[] = []
    for (const [id, mail] of Object.entries(state.terminals)) {
      const count = messageCount(mail)
      const more = count > (counts.get(id) ?? count)
      counts.set(id, count)
      if (!hasMail(mail)) continue
      const { terminalId, ...target } = companionKeyOf(id)
      actions.push({ type: "bar/arrive", target, terminalId, key: messagesKey })
      if (more) actions.push({ type: "bar/reopen", target, terminalId, key: messagesKey })
    }
    if (actions.length) session.workspace.transact(actions)
  }
}

export const createPanes = ({
  companions,
  workspace,
  messages,
}: {
  readonly companions: Companions
  readonly workspace: WorkspaceStore
  readonly messages?: Messages | undefined
}): Panes => {
  const session: Session = {
    companions,
    workspace,
    panes: createStore<PaneState>(emptyState),
    followed: new Map(),
    saving: new Map(),
    waiting: new Map(),
    pending: new Map(),
    failures: new Map(),
    unconfirmed: new Map(),
  }
  const watch = (target: WorkspaceTarget, id: ItemId): (() => void) => {
    const entry =
      session.followed.get(id) ?? follow(session, target, id, { watchers: 0, plan: false })
    entry.watchers += 1
    let released = false
    return () => {
      if (released) return
      released = true
      entry.watchers -= 1
      if (entry.watchers === 0 && !entry.plan && session.followed.get(id) === entry)
        release(session, id)
    }
  }
  const reveal = (target: WorkspaceTarget, id: ItemId): void => {
    session.panes.update((state) =>
      state.revealed[id] ? state : { ...state, revealed: { ...state.revealed, [id]: true } },
    )
    const entry = session.followed.get(id)
    if (!entry || entry.reveal) return
    unfollow(session, id)
    follow(session, target, id, { watchers: entry.watchers, plan: entry.plan })
  }
  const plan = (target: WorkspaceTarget, id: ItemId): PlanActions => ({
    edit: (text, marks) => {
      const edited = withPlan(session, id, (current) =>
        // A plan the backend can't write takes no edits.
        text === current.text || !current.writable
          ? current
          : { ...current, text, marks, marked: text },
      )
      if (edited) saveSoon(session, target, id)
    },
    closeEditor: () => {
      // The note code is already loaded: the editor that closed shares it.
      void import("./plan-editor/notes").then(({ withoutEmptyNotes }) => {
        withPlan(session, id, (current) => {
          if (!current.writable) return current
          const kept = withoutEmptyNotes(current.text, currentMarks(current))
          return kept ? { ...current, ...kept, marked: kept.text } : current
        })
        saveNow(session, target, id)
      })
    },
    flush: () => saveNow(session, target, id),
    toggleChanges: () => {
      withPlan(session, id, (current) => ({ ...current, showChanges: !current.showChanges }))
    },
  })
  const connect = (): (() => void) => {
    const noteMail = mailFollower(session)
    reconcile(session, workspace.getSnapshot())
    if (messages) noteMail(messages.state.getSnapshot())
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
    const stopMail =
      messages?.state.subscribe(() => noteMail(messages.state.getSnapshot())) ?? (() => {})
    return () => {
      stopWorkspace()
      stopMail()
      for (const id of session.followed.keys()) unfollow(session, id)
    }
  }
  return { store: session.panes, watch, reveal, plan, connect }
}
