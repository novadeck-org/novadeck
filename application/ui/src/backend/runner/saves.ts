import { maxClientStateLength, maxWebSocketMessageBytes } from "@novadeck/protocol"
import { hasCode } from "@novadeck/protocol/client"

import type { Workspace, WorkspaceSession } from "../../model/types"
import { encodeSession } from "./session-state"

export type SessionSavesOptions = {
  // Sends one session's state to the runner.
  readonly save: (sessionId: string, state: string) => Promise<void>
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
  // What the runner already holds for each session, so an unchanged state is not sent.
  readonly saved: Iterable<readonly [string, string]>
}

export type SessionSaves = {
  // Marks the sessions this workspace changed since the last one; the first workspace
  // noted is what the runner already has.
  readonly note: (workspace: Workspace) => void
  // Sends what changed after a quiet spell.
  readonly schedule: () => void
  // Sends what changed now.
  readonly flush: () => void
  // Sends what changed now and resolves once every save sent so far has been answered,
  // as before a window closes or the app quits.
  readonly settle: () => Promise<void>
  // Whether a send waits for its spell.
  readonly busy: () => boolean
}

const backoffMs = 500
// Room for the request around the state in its WebSocket message.
const envelopeBytes = 8 * 1024

// Whether the runner accepts the state: it has a length limit of its own, and the
// message carries it JSON-escaped inside the request.
const fitsRunner = (state: string): boolean =>
  state.length <= maxClientStateLength &&
  new TextEncoder().encode(JSON.stringify(state)).length <= maxWebSocketMessageBytes - envelopeBytes

// Where the session stands in the workspace, so a reload can tell apart sessions
// visited at the same moment: 2 for the open one, 1 for its project's last one.
const findSession = (
  workspace: Workspace | undefined,
  id: string,
): { readonly session: WorkspaceSession; readonly rank: number } | undefined => {
  for (const project of workspace?.projects ?? []) {
    const session = project.history.find((item) => item.id === id)
    if (!session) continue
    const current = project.activeSessionId === id
    return { session, rank: current ? (workspace!.activeProjectId === project.id ? 2 : 1) : 0 }
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
  const dirty = new Set<string>()
  let baseline = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const sending = new Set<Promise<void>>()
  const flush = (): void => {
    clearTimeout(timer)
    timer = undefined
    for (const id of dirty) {
      dirty.delete(id)
      const found = findSession(latest(), id)
      const exists = ready(id)
      if (!found || !exists) continue
      const state = encodeSession(found.session, found.rank)
      // Unchanged, or more than the runner accepts: a state it would reject is dropped.
      if (saved.get(id) === state || !fitsRunner(state)) continue
      const sent = track(
        exists.then(async (ok) => {
          if (!ok) return
          try {
            await save(id, state)
            saved.set(id, state)
          } catch (error) {
            if (halted()) return
            // Unreachable: try again after the next change or reconnection.
            if (hasCode(error, "DISCONNECTED")) dirty.add(id)
            // Too many calls in flight: try again shortly.
            if (hasCode(error, "RESOURCE_LIMIT")) {
              dirty.add(id)
              if (!timer) timer = setTimeout(flush, backoffMs)
            }
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
      for (const session of workspace.projects.flatMap((project) => project.history)) {
        if (seen.get(session.id) === session) continue
        seen.set(session.id, session)
        if (baseline) dirty.add(session.id)
      }
      baseline = true
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
