import type { Workspace, WorkspaceSession } from "@novadeck/core/types"
import { maxClientStateLength } from "@novadeck/protocol"
import { hasCode } from "@novadeck/runner-client"

import { fitsRunner } from "../fits"
import { reportCaught } from "../streams"
import { encodeSession } from "./state"
import { keepWindowSession } from "./views"

// What a save holds: the state and the visit are sent together, and a visit alone is a change.
// `revision` is the runner's for that state, where it keeps them (from revision 4 of the
// contract), so a newer one another client wrote replaces this.
export type SavedState = {
  readonly state: string
  readonly visitedAt: number | null
  readonly revision?: number | undefined
}

export type SessionSavesOptions = {
  // Sends one session's state and last visit to the runner, as a change to `previous` (what it
  // last held) where it can; resolves the revision it holds them at, where it keeps one.
  readonly save: (
    sessionId: string,
    state: string,
    visitedAt: number | null,
    previous: SavedState | undefined,
  ) => Promise<number | undefined>
  // Resolves whether the session exists on the runner; undefined for one it never heard of.
  readonly ready: (sessionId: string) => Promise<boolean> | undefined
  // The workspace as last committed.
  readonly latest: () => Workspace | undefined
  // Counts the promise as outstanding I/O until it settles.
  readonly track: <T>(work: Promise<T>) => Promise<T>
  // The backend stopped: a failed save is not tried again.
  readonly halted: () => boolean
  // How long saving waits for more changes, in milliseconds.
  readonly delay: number
  // What the runner already holds for each session, so an unchanged state and visit are
  // not sent.
  readonly saved: Iterable<readonly [string, SavedState]>
}

export type SessionSaves = {
  // Marks the sessions this workspace changed since the last one; the first workspace
  // noted is what the runner already has.
  readonly note: (workspace: Workspace) => void
  // Sends what changed after a quiet spell.
  readonly schedule: () => void
  // Sends what changed now.
  readonly flush: () => void
  // Notes what the runner holds for sessions this window read again, or another client wrote,
  // so what it read is not sent back.
  readonly held: (entries: Iterable<readonly [string, SavedState]>) => void
  // What the runner holds of the session, as this window last knew it.
  readonly savedOf: (sessionId: string) => SavedState | undefined
  // Sends the session's state with the next spell, as after another client's change, which
  // its own unsent changes now lay over.
  readonly touch: (sessionId: string) => void
  // Sends what changed now and resolves once every save sent so far has been answered,
  // as before a window closes or the app quits.
  readonly settle: () => Promise<void>
  // Whether a send waits for its spell.
  readonly busy: () => boolean
}

const backoffMs = 500

const findSession = (
  workspace: Workspace | undefined,
  id: string,
): WorkspaceSession | undefined => {
  for (const project of workspace?.projects ?? []) {
    const session = project.history.find((item) => item.id === id)
    if (session) return session
  }
  return undefined
}

// Saving: every changed session is sent after a quiet spell, or at once on flush.
export const createSessionSaves = ({
  save,
  ready,
  latest,
  track,
  halted,
  delay,
  saved: initial,
}: SessionSavesOptions): SessionSaves => {
  const saved = new Map(initial)
  const seen = new Map<string, WorkspaceSession>()
  // The session each project shows here, which this window keeps for its next launch.
  const shownSession = new Map<string, string>()
  const dirty = new Set<string>()
  let baseline = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const sending = new Set<Promise<void>>()
  // By session: how often what the runner holds was noted (`held`), how many saves were sent,
  // and which of them landed last, so an answer only says what was sent where nothing newer
  // was held or sent and answered since.
  const heldTimes = new Map<string, number>()
  const sends = new Map<string, number>()
  const landed = new Map<string, number>()
  const flush = (): void => {
    clearTimeout(timer)
    timer = undefined
    for (const id of dirty) {
      dirty.delete(id)
      const found = findSession(latest(), id)
      const exists = ready(id)
      if (!found || !exists) continue
      const state = encodeSession(found)
      const { visitedAt } = found
      const last = saved.get(id)
      // More than the runner accepts, a state it would reject is dropped; a visit still goes,
      // with the state the runner last kept.
      const next = fitsRunner(state, maxClientStateLength) ? state : last?.state
      if (next === undefined || (last?.state === next && last.visitedAt === visitedAt)) continue
      const send = (sends.get(id) ?? 0) + 1
      sends.set(id, send)
      const times = heldTimes.get(id) ?? 0
      const sent = track(
        exists.then(async (ok) => {
          // Its session isn't on the runner yet: sent with the next change or reconnection,
          // which asks for the session again.
          if (!ok) {
            if (!halted()) dirty.add(id)
            return
          }
          try {
            const revision = await save(id, next, visitedAt, last)
            // Unless what it holds was read again, or another client's change held, on the way,
            // which is newer and holds this save; or a later save landed first.
            if ((heldTimes.get(id) ?? 0) === times && send > (landed.get(id) ?? 0)) {
              saved.set(id, { state: next, visitedAt, revision })
              landed.set(id, send)
            }
          } catch (error) {
            if (halted()) return
            // Unreachable: try again after the next change or reconnection.
            if (hasCode(error, "DISCONNECTED")) dirty.add(id)
            // Too many calls in flight: try again shortly.
            else if (hasCode(error, "RESOURCE_LIMIT")) {
              dirty.add(id)
              if (!timer) timer = setTimeout(flush, backoffMs)
            }
            // A runner shutting down refuses saves on purpose, so its shells' exits never
            // overwrite what it kept; anything else is logged.
            else if (!hasCode(error, "CLOSING")) reportCaught(error)
          }
        }),
      )
      sending.add(sent)
      void sent.then(() => sending.delete(sent))
    }
  }
  const schedule = (): void => {
    if (dirty.size && !timer) timer = setTimeout(flush, delay)
  }
  return {
    note: (workspace) => {
      for (const { id, activeSessionId } of workspace.projects) {
        if (shownSession.get(id) === activeSessionId) continue
        shownSession.set(id, activeSessionId)
        keepWindowSession(id, activeSessionId)
      }
      for (const session of workspace.projects.flatMap((project) => project.history)) {
        if (seen.get(session.id) === session) continue
        seen.set(session.id, session)
        if (baseline) dirty.add(session.id)
      }
      baseline = true
      schedule()
    },
    held: (entries) => {
      for (const [id, state] of entries) {
        saved.set(id, state)
        heldTimes.set(id, (heldTimes.get(id) ?? 0) + 1)
      }
    },
    savedOf: (sessionId) => saved.get(sessionId),
    touch: (sessionId) => {
      dirty.add(sessionId)
      schedule()
    },
    schedule,
    flush,
    settle: async () => {
      flush()
      // eslint-disable-next-line no-await-in-loop -- An answer may leave more to wait for.
      while (sending.size) await Promise.allSettled(sending)
    },
    busy: () => timer !== undefined,
  }
}
