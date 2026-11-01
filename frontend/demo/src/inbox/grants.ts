import type { Grant, Grants } from "@novadeck/core/grants"
import type { InboxAnswer, InboxRow } from "@novadeck/core/inbox"
import { createStore } from "@novadeck/core/store"

// The demo's grants: made from the Grant and approval cards' answers as the runner makes them,
// listed while they last, and gone when revoked or ended.

const hour = 3_600_000

export type DemoGrants = Grants & {
  // A grant of the demo's own appears, as one the runner made.
  readonly add: (grant: Grant) => void
  // A grant ends by its time, with no revoke: it leaves the list. `add` ends one itself when
  // its time is up; this ends one at once.
  readonly end: (id: string) => void
  // The grant's terminal ran a command it allowed.
  readonly use: (id: string, use: NonNullable<Grant["lastUse"]>) => void
  // Every grant leaves.
  readonly empty: () => void
}

export const createDemoGrants = (now: () => number = Date.now): DemoGrants => {
  const state = createStore<readonly Grant[]>([])
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const drop = (id: string): void => {
    clearTimeout(timers.get(id))
    timers.delete(id)
    state.update((current) => current.filter((each) => each.id !== id))
  }
  return {
    state,
    add: (grant) => {
      clearTimeout(timers.get(grant.id))
      state.update((current) => [...current.filter((each) => each.id !== grant.id), grant])
      // An hour grant's time is up when the clock says so, as the runner's sweep ends it; one
      // that lasts until done stays until it is revoked.
      if (grant.endsAt === null) return
      const left = grant.endsAt - now()
      if (left <= 0) drop(grant.id)
      else
        timers.set(
          grant.id,
          setTimeout(() => drop(grant.id), left),
        )
    },
    end: drop,
    revoke: drop,
    use: (id, lastUse) =>
      state.update((current) =>
        current.map((each) => (each.id === id ? { ...each, lastUse } : each)),
      ),
    empty: () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      state.update(() => [])
    },
  }
}

// The grant the person's answer to `row` makes: a Grant on a lead's card, with what stayed
// ticked, or an Approve on an approval ask, for the asking terminal alone. Undefined for any
// other answer.
export const grantMadeBy = (row: InboxRow, answer: InboxAnswer, now: number): Grant | undefined => {
  const { source } = row
  const base = {
    id: `grant-${row.id}`,
    projectId: source.projectId,
    workspaceSessionId: source.workspaceSessionId,
    entryId: row.id,
    proposedBy: source.handle,
    madeAt: now,
    revokedAt: null,
    lastUse: null,
  }
  if (row.kind === "grant" && answer.kind === "grant") {
    const { proposal } = row
    const picked = answer.answer
    return {
      ...base,
      holder: { kind: "team", lead: source.handle, withLead: picked.withLead },
      presets: [...picked.presets],
      commands: picked.commands.flatMap((at) => proposal.commands[at] ?? []),
      repos: proposal.repos.flatMap(({ repo }) => (picked.repos.includes(repo.url) ? [repo] : [])),
      lifetime: picked.lifetime,
      endsAt: picked.lifetime === "hour" ? now + hour : null,
    }
  }
  if (
    row.kind === "ask" &&
    row.ask.shape.type === "approval" &&
    answer.kind === "ask" &&
    answer.answer.type === "approve"
  )
    return {
      ...base,
      lifetime: answer.answer.lifetime,
      endsAt: answer.answer.lifetime === "hour" ? now + hour : null,
      holder: { kind: "terminal", handle: source.handle },
      presets: [],
      commands: [...row.ask.shape.commands],
      repos: [],
    }
  return undefined
}
