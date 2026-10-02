import {
  companionKeyId,
  companionKeyOf,
  notesIn,
  type ArtifactContent,
  type CompanionKey,
  type Companions,
  type PlanSnapshot,
} from "../../model/companion"
import { hasMail, type MailState, type Messages, type TerminalMail } from "../../model/messages"
import { createStore, type MutableStore, type Store } from "../../model/store"
import type { ViewMode } from "../../model/types"
import {
  arrived,
  emptyPane,
  mailTab,
  paneOf,
  planAdded,
  planRemoved,
  planTab,
  reading,
  reopen,
  settle,
  show,
  withPlan,
  type Pane,
  type Shown,
} from "./pane"
import { currentMarks, eolOf, lf, type Mark } from "./plan-doc"

// Every terminal's companion pane, kept for as long as the app runs: what its backend's
// companions report, the person's choices in it, and its plans' saves. Components read
// it through ./use-panes.ts; commands change it like any store.

// Where the pane opens: beside the terminal inside its window, or hanging off a canvas
// node.
export type PlanPresentation = "split" | "attached"

// Beside the terminal, or on the canvas, attached to the terminal's node.
export const presentationOf = (view: ViewMode): PlanPresentation =>
  view === "canvas" ? "attached" : "split"

// Every terminal's pane by `companionKeyId`. A terminal with nothing yet has none.
export type PaneMap = Readonly<Record<string, Pane>>

// What can be done with a terminal's pane, apart from rendering it.
export type PaneActions = {
  readonly current: () => Pane
  readonly update: (update: (pane: Pane) => Pane) => void
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

export type Panes = {
  readonly store: Store<PaneMap>
  readonly of: (key: CompanionKey) => PaneActions
  // Follows the backend's companions and messages from here on, starting from what they
  // hold now; returns the stop.
  readonly connect: () => () => void
}

type Session = {
  readonly companions: Companions
  readonly panes: MutableStore<PaneMap>
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
  readonly empty: Map<string, Pane>
}

const emptyFor = (session: Session, key: CompanionKey): Pane => {
  const id = companionKeyId(key)
  const pane = session.empty.get(id) ?? emptyPane(key)
  session.empty.set(id, pane)
  return pane
}

const planId = (key: CompanionKey, ref: string): string => `${companionKeyId(key)}#${ref}`

// Changes a terminal's pane, giving one to a terminal that had none. The changed pane, or
// undefined when nothing changed.
const change = (
  session: Session,
  key: CompanionKey,
  update: (pane: Pane) => Pane,
): Pane | undefined => {
  let changed: Pane | undefined
  const id = companionKeyId(key)
  session.panes.update((current) => {
    const pane = current[id] ?? emptyFor(session, key)
    const next = settle(update(pane))
    if (next === pane) return current
    changed = next
    return { ...current, [id]: next }
  })
  return changed
}

const planIn = (session: Session, key: CompanionKey, ref: string) =>
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
  change(session, key, (pane) => {
    const revised = withPlan(pane, snapshot.ref, (plan) => {
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
    })
    // A new iteration of a plan the person closed brings it back to the taskbar.
    const rewrote = (from: Pane): number =>
      from.plans.find((plan) => plan.ref === snapshot.ref)?.writes ?? 0
    return rewrote(revised) > rewrote(pane) ? reopen(revised, planTab(snapshot.ref)) : revised
  })
  // This version settles what the file holds; saves still unanswered no longer matter.
  session.unconfirmed.delete(id)
  persist(session, key, snapshot.ref)
}

// How many messages a terminal's threads hold.
const received = (mail: TerminalMail | undefined): number =>
  (mail?.threads ?? []).reduce((count, thread) => count + thread.messages.length, 0)

// The messages join a terminal's taskbar when it first has them, after what came before,
// and come back once closed with the next message, whether or not the terminal is on
// screen. `note` takes the messages as they stand: `reopening` once they're followed.
const mailFollower = (session: Session) => {
  const counts = new Map<string, number>()
  return (state: MailState, reopening: boolean): void => {
    for (const [id, mail] of Object.entries(state.terminals)) {
      const count = received(mail)
      const more = count > (counts.get(id) ?? count)
      counts.set(id, count)
      if (!hasMail(mail)) continue
      // Closed, they stay off the bar until a message comes.
      change(session, companionKeyOf(id), (pane) =>
        !pane.closed.includes(mailTab)
          ? arrived(pane, mailTab)
          : reopening && more
            ? reopen(pane, mailTab)
            : pane,
      )
    }
  }
}

export const createPanes = (companions: Companions, messages?: Messages): Panes => {
  const session: Session = {
    companions,
    panes: createStore<PaneMap>({}),
    saving: new Map(),
    waiting: new Map(),
    pending: new Map(),
    failures: new Map(),
    unconfirmed: new Map(),
    content: new Map(),
    empty: new Map(),
  }
  // What came before: a pane for each terminal the backend reports and this store doesn't
  // know yet. Read as the store is made, so the first paint shows them as they are.
  const seed = (): void => {
    session.panes.update((current) => {
      const unknown = companions
        .snapshot()
        .filter((snapshot) => !current[companionKeyId(snapshot.key)])
      return unknown.length
        ? {
            ...current,
            ...Object.fromEntries(
              unknown.map((snapshot) => [companionKeyId(snapshot.key), paneOf(snapshot)]),
            ),
          }
        : current
    })
  }
  const note = mailFollower(session)
  const noteMail = (reopening: boolean): void => {
    if (messages) note(messages.state.getSnapshot(), reopening)
  }
  seed()
  noteMail(false)
  const follow = (): (() => void) => {
    // Anything that came while the store wasn't following.
    seed()
    noteMail(true)
    const stopCompanions = companions.subscribe((event) => {
      const id = companionKeyId(event.key)
      if (event.type === "companion/closed") {
        session.panes.update(({ [id]: _closed, ...rest }) => rest)
        return
      }
      if (event.type === "artifact/shown") {
        change(session, event.key, (pane) => show(pane, event.artifact, event.asked, event.seen))
        return
      }
      if (event.type === "plan/removed") {
        change(session, event.key, (pane) => planRemoved(pane, event.ref))
        return
      }
      if (planIn(session, event.key, event.plan.ref)) void revise(session, event.key, event.plan)
      else change(session, event.key, (pane) => planAdded(pane, event.plan))
    })
    const stopMail = messages?.state.subscribe(() => noteMail(true)) ?? (() => {})
    return () => {
      stopCompanions()
      stopMail()
    }
  }
  const of = (key: CompanionKey): PaneActions => {
    const id = companionKeyId(key)
    return {
      current: () => session.panes.getSnapshot()[id] ?? emptyFor(session, key),
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
        // Only its latest version is kept: an image shown again and again would pile up.
        for (const each of session.content.keys())
          if (each.startsWith(`${id}/${artifact.id}@`)) session.content.delete(each)
        const loading = companions.load(key, artifact.id)
        session.content.set(cached, loading)
        // A load that failed is tried again the next time the artifact is opened.
        loading.catch(() => session.content.delete(cached))
        return loading
      },
    }
  }
  return { store: session.panes, of, connect: follow }
}
