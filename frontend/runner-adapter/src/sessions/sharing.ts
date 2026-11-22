import type { BackendAction } from "@novadeck/core/port"
import { savedIds, sharedState } from "@novadeck/core/restore"
import type { Workspace, WorkspaceSession as UiSession } from "@novadeck/core/types"
import type { SessionChange, SessionPatch, WorkspaceSession } from "@novadeck/protocol"
import { hasCode, type Runner } from "@novadeck/runner-client"

import { consume, reportCaught } from "../streams"
import { applyPatch, diffPatch, emptyPatch, fitsContract, restored } from "./patch"
import type { SavedState, SessionSaves } from "./saves"
import { decodeSession, encodeSession } from "./state"
import { deviceView, keepDeviceView, viewKeys, viewOf, type DeviceView } from "./views"

// A session's state shared with the other clients of its runner: what this one changes goes as
// a patch a record at a time (patch.ts), and what another changes arrives on the runner's feed
// (`sessions.watch`), with this client's own changes not yet in it laid over it, so neither
// loses the other's. A runner from before revision 3 of the contract has neither: saves replace
// the state, as before, and nothing arrives.
//
// For each session this keeps what the runner was last seen to hold (`confirmed`: from a
// listing or the feed, never from an answer, which says only that a patch landed), and the
// patches this client sent that it doesn't show yet (`sent`); the two make its base. What this
// client changed is what differs from the state as it last laid it in, loaded it or sent it
// (the saves' `saved`), never from the base: so what the repair a load does took out of what
// arrived (a terminal or window not known here yet, an item not held) stays out here and on
// the runner alike, and is laid in again once it's known here.

const parsed = (text: string | null | undefined): unknown => {
  if (text === null || text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// A saved state as JSON with every object's keys in order, and without what is each device's
// own (views.ts), so two states that share the same compare the same.
const shared = (text: string | undefined): string | undefined => {
  const value = parsed(text)
  if (value === undefined) return undefined
  const state = (value as { readonly state?: unknown }).state
  const apart =
    typeof state === "object" && state !== null
      ? {
          ...value,
          state: Object.fromEntries(
            Object.entries(state).filter(([key]) => !(viewKeys as readonly string[]).includes(key)),
          ),
        }
      : value
  return JSON.stringify(apart, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => a.localeCompare(b)))
      : inner,
  )
}

const located = (
  workspace: Workspace | undefined,
  sessionId: string,
): { readonly projectId: string; readonly session: UiSession } | undefined => {
  for (const project of workspace?.projects ?? []) {
    const session = project.history.find((each) => each.id === sessionId)
    if (session) return { projectId: project.id, session }
  }
  return undefined
}

// `saved` with the view `from` holds, where it holds one.
const withViewOf = (saved: unknown, from: unknown): unknown => {
  const view = viewOf(from)
  const state = (saved as { readonly state?: unknown } | undefined)?.state
  if (!view || typeof state !== "object" || state === null) return saved
  return { ...(saved as object), state: { ...state, ...view } }
}

type Confirmed = {
  readonly state: string | null
  readonly visitedAt: number | null
  readonly revision: number
}
// A patch sent, and the revision it landed as once answered.
type Sent = { readonly patch: SessionPatch; revision?: number }

const isViewPath = (path: readonly string[]): boolean =>
  path.length === 2 && path[0] === "state" && (viewKeys as readonly string[]).includes(path[1]!)

// `patch` without where the person looks, which is each device's own (views.ts).
const withoutView = (patch: SessionPatch): SessionPatch => ({
  set: patch.set.filter(({ path }) => !isViewPath(path)),
  unset: patch.unset.filter((path) => !isViewPath(path)),
})

const nothing: SessionPatch = { set: [], unset: [] }

export type SessionSharing = {
  // How a session's state goes to the runner (`SessionSavesOptions.save`).
  readonly save: (
    sessionId: string,
    state: string,
    visitedAt: number | null,
    previous: SavedState | undefined,
  ) => Promise<number | undefined>
  // Sessions as the runner listed them, at the start or as a project is read again, whose
  // states this client now shows as they are: held for the saves (`SessionSaves.held`).
  readonly listed: (sessions: readonly WorkspaceSession[]) => void
  // After each commit: lays in what was read once it's in place here, at the first commit
  // (`initial`) or with each project put back as read (`synced`, as `project/sync` does); and
  // a session again once a terminal or window its shared state names, which this client
  // didn't know, is known here.
  readonly seen: (initial: boolean, synced: readonly string[]) => void
  // Follows the runner's feed, where it has one, until `stop`.
  readonly follow: () => void
  readonly stop: () => void
}

export const createSessionSharing = (options: {
  readonly runner: Pick<Runner, "sessions" | "supports">
  readonly saves: () => SessionSaves
  readonly latest: () => Workspace | undefined
  readonly dispatch: (actions: readonly BackendAction[]) => void
  readonly track: <T>(work: Promise<T>) => Promise<T>
}): SessionSharing => {
  const { runner } = options
  // Whether the runner has the procedure; a client of one that can't say has none of these.
  const has = (path: "sessions.change" | "sessions.watch"): boolean =>
    typeof (runner as Partial<typeof runner>).supports === "function" && runner.supports(path)
  // This client's own name for its changes, which the feed passes on.
  const writer = crypto.randomUUID()
  const confirmed = new Map<string, Confirmed>()
  const sent = new Map<string, Sent[]>()
  // Where this client last looked in each session, as it loaded or last saved it: its view
  // goes into the shared state only once the person changed it here, never just because
  // another client's differs, which would send each's back to the other for ever.
  const looked = new Map<string, DeviceView>()
  // By session, the terminals and windows its shared state names that aren't known here.
  const unknown = new Map<string, ReadonlySet<string>>()
  // Sessions listed, by the revision they were read at, to lay in once what was read is in
  // place here.
  const fresh = new Map<string, number>()
  let stream: AsyncIterableIterator<SessionChange, undefined> | undefined

  // What this client's patches it doesn't show yet make of `state`.
  const withSent = (sessionId: string, state: unknown): unknown =>
    (sent.get(sessionId) ?? []).reduce<unknown>(
      (value, { patch }) => applyPatch(value, patch),
      state ?? {},
    )

  // The runner's state with this client's patches laid over it; undefined where the runner
  // holds none and nothing was sent.
  const baseOf = (sessionId: string, known: Confirmed): string | undefined =>
    known.state === null && !sent.get(sessionId)?.length
      ? undefined
      : JSON.stringify(withSent(sessionId, parsed(known.state)))

  // Takes what the runner holds now as seen, if it's newer than what was; whether it was.
  const confirm = (sessionId: string, next: Confirmed): boolean => {
    const known = confirmed.get(sessionId)
    if (known && next.revision <= known.revision) return false
    confirmed.set(sessionId, next)
    // Its patches that landed by then are in it.
    const own = sent
      .get(sessionId)
      ?.filter((each) => each.revision === undefined || each.revision > next.revision)
    if (own?.length) sent.set(sessionId, own)
    else sent.delete(sessionId)
    return true
  }

  // Notes which terminals and windows the session's shared state names that aren't known
  // here, to lay it in again once they are.
  const noteUnknown = (sessionId: string, state: UiSession["state"], named: string | undefined) => {
    const decoded = decodeSession(named ?? null)?.state
    const present = new Set(
      [...state.roster.terminals, ...state.roster.windows].map(({ id }) => id),
    )
    const absent = new Set(
      decoded
        ? [...savedIds(decoded.layout, decoded.order), ...Object.keys(decoded.bars ?? {})].filter(
            (id) => !present.has(id),
          )
        : [],
    )
    if (absent.size) unknown.set(sessionId, absent)
    else unknown.delete(sessionId)
  }

  // What this client shows of the session, after what the runner holds moved: that, with
  // what this client changed and hasn't sent laid over it, put back together as a load puts
  // a saved state, which leaves out what isn't known here. The saves hold it as laid in, but
  // for those changes, which the next spell sends: so what the repair left out is never sent
  // as taken out. `listedAt`: the session was just read at that revision, and what was read is
  // in place here, nothing of it this client's own change.
  const reconcile = (sessionId: string, listedAt?: number): void => {
    const known = confirmed.get(sessionId)
    const base = known && baseOf(sessionId, known)
    if (!known || base === undefined) return
    const saves = options.saves()
    const here = located(options.latest(), sessionId)
    if (!here) {
      saves.held([
        [sessionId, { state: base, visitedAt: known.visitedAt, revision: known.revision }],
      ])
      unknown.delete(sessionId)
      return
    }
    const local = encodeSession(here.session)
    const hold = (state: string): void =>
      saves.held([[sessionId, { state, visitedAt: known.visitedAt, revision: known.revision }]])
    noteUnknown(sessionId, here.session.state, base)
    // Read as the runner holds it, and nothing on its way: laid in as shown.
    if (listedAt !== undefined && known.revision <= listedAt && !sent.get(sessionId)?.length) {
      hold(local)
      return
    }
    // As it was last laid in, loaded or sent; where it never was, or was just read, nothing of
    // it is known as this client's own.
    const last = listedAt === undefined ? saves.savedOf(sessionId)?.state : undefined
    const laid = last === undefined ? undefined : parsed(last)
    const own = laid === undefined ? nothing : withoutView(diffPatch(laid, parsed(local)))
    const merged = applyPatch(parsed(base), own)
    const decoded = decodeSession(JSON.stringify(merged))
    let shown = here.session
    if (decoded) {
      const { order, layout, bars } = decoded.state
      const view = { order, layout, ...(bars && { bars }) }
      shown = { ...here.session, state: sharedState(here.session.state, view) }
      if (shared(encodeSession(shown)) !== shared(local))
        options.dispatch([
          {
            type: "session/shared",
            projectId: here.projectId,
            workspaceSessionId: sessionId,
            shared: view,
          },
        ])
    }
    hold(JSON.stringify(restored(parsed(encodeSession(shown)), parsed(base), own)))
    if (!emptyPatch(own)) saves.touch(sessionId)
  }

  const save: SessionSharing["save"] = async (sessionId, state, visitedAt, previous) => {
    // Where this device looks is its own, kept here as the state goes.
    const own = decodeSession(state)?.state
    if (own) keepDeviceView(sessionId, own)
    // What it last sent, where it never laid one in: its first save is still on its way.
    const before =
      previous === undefined
        ? sent.get(sessionId)?.length
          ? withSent(sessionId, {})
          : {}
        : parsed(previous.state)
    const after = parsed(state)
    const whole = async (): Promise<undefined> => {
      await runner.sessions.save({ sessionId, state, visitedAt })
      return undefined
    }
    if (!has("sessions.change") || before === undefined || after === undefined) return whole()
    const view = viewOf(after)
    const last = looked.get(sessionId)
    if (view) looked.set(sessionId, view)
    const unmoved =
      last !== undefined && view !== undefined && viewKeys.every((key) => last[key] === view[key])
    const patch = diffPatch(before, unmoved ? withViewOf(after, before) : after)
    // A state with a key the contract can't name a record by (empty, overlong, `__proto__`)
    // goes whole, as before.
    if (!fitsContract(patch)) return whole()
    // A visit only moves on: another client's later one stands.
    const visit =
      visitedAt !== null && (previous?.visitedAt == null || visitedAt > previous.visitedAt)
        ? visitedAt
        : undefined
    if (emptyPatch(patch) && visit === undefined) return previous?.revision
    const entry: Sent = { patch }
    sent.set(sessionId, [...(sent.get(sessionId) ?? []), entry])
    const forget = (): void => {
      const rest = (sent.get(sessionId) ?? []).filter((each) => each !== entry)
      if (rest.length) sent.set(sessionId, rest)
      else sent.delete(sessionId)
    }
    try {
      const { revision } = await runner.sessions.change({
        sessionId,
        writer,
        base: confirmed.get(sessionId)?.revision ?? 0,
        patch,
        ...(visit !== undefined && { visitedAt: visit }),
      })
      entry.revision = revision
      // What arrived while it was on its way already holds it, or a later change over it.
      if ((confirmed.get(sessionId)?.revision ?? -1) >= revision) {
        forget()
        reconcile(sessionId)
      }
      return revision
    } catch (error) {
      forget()
      throw error
    }
  }

  // Another client's session as it is now.
  const arrived = (session: WorkspaceSession): void => {
    if (session.revision === undefined) return
    const next = { state: session.state, visitedAt: session.visitedAt, revision: session.revision }
    if (!confirm(session.id, next)) return
    const here = located(options.latest(), session.id)
    // Its name as the runner holds it now, shown here and never sent back.
    if (here && here.session.name !== session.name)
      options.dispatch([
        {
          type: "session/shared",
          projectId: here.projectId,
          workspaceSessionId: session.id,
          name: session.name,
        },
      ])
    reconcile(session.id)
  }

  const forgotten = (sessionId: string): void => {
    confirmed.delete(sessionId)
    sent.delete(sessionId)
    looked.delete(sessionId)
    unknown.delete(sessionId)
    fresh.delete(sessionId)
  }

  // Sessions the runner holds newer than this client knows, as the feed opens: read again.
  const caughtUp = async (revisions: Readonly<Record<string, number>>): Promise<void> => {
    const projects = new Set<string>()
    for (const project of options.latest()?.projects ?? [])
      for (const session of project.history) {
        const now = revisions[session.id]
        if (now !== undefined && now > (confirmed.get(session.id)?.revision ?? -1))
          projects.add(project.id)
      }
    for (const projectId of projects)
      // eslint-disable-next-line no-await-in-loop -- One project read at a time.
      for (const session of await options.track(runner.sessions.list({ projectId })))
        arrived(session)
  }

  // Lays in, after the commit under way, what `seen` found (with the revision it was read at,
  // for a session just read).
  const due = new Map<string, number | undefined>()
  const later = (found: ReadonlyMap<string, number | undefined>): void => {
    if (!found.size) return
    const idle = due.size === 0
    for (const [sessionId, listedAt] of found)
      due.set(sessionId, due.has(sessionId) ? (due.get(sessionId) ?? listedAt) : listedAt)
    if (idle)
      queueMicrotask(() => {
        const now = [...due]
        due.clear()
        for (const [sessionId, listedAt] of now) reconcile(sessionId, listedAt)
      })
  }

  return {
    save,
    listed: (sessions) => {
      const states: [string, SavedState][] = []
      for (const session of sessions) {
        const { id, state, visitedAt, revision } = session
        // Where this device looks as it loads the session (seed.ts).
        if (!looked.has(id)) {
          const view = deviceView(id) ?? viewOf(parsed(state))
          if (view) looked.set(id, view)
        }
        if (revision !== undefined) {
          confirm(id, { state, visitedAt, revision })
          fresh.set(id, revision)
        }
        // What's read is what this client shows now: nothing of it is its own change.
        if (state !== null) states.push([id, { state, visitedAt, revision }])
      }
      if (states.length) options.saves().held(states)
    },
    seen: (initial, synced) => {
      const workspace = options.latest()
      const found = new Map<string, number | undefined>()
      for (const [sessionId, revision] of fresh) {
        const here = located(workspace, sessionId)
        if (!here || (!initial && !synced.includes(here.projectId))) continue
        fresh.delete(sessionId)
        found.set(sessionId, revision)
      }
      for (const [sessionId, absent] of unknown) {
        const roster = located(workspace, sessionId)?.session.state.roster
        if (
          !found.has(sessionId) &&
          roster &&
          [...roster.terminals, ...roster.windows].some((tile) => absent.has(tile.id))
        )
          found.set(sessionId, undefined)
      }
      later(found)
    },
    follow: () => {
      if (stream || !has("sessions.watch")) return
      const changes = runner.sessions.watch()
      stream = changes
      // As the other streams are: an item's trouble is reported, and the stream's own end, as
      // once the runner closed for good, is quiet.
      void consume(changes, (change) => {
        if (stream !== changes) return
        if (change.type === "revisions")
          void caughtUp(change.revisions).catch((error: unknown) => {
            // The feed opens again with the link, and reads again what it missed then.
            if (!hasCode(error, "DISCONNECTED", "CLOSING")) reportCaught(error)
          })
        else if (change.type === "changed") arrived(change.session)
        else forgotten(change.sessionId)
      })
    },
    stop: () => {
      const ended = stream
      stream = undefined
      void ended?.return?.()?.catch(() => {})
    },
  }
}
