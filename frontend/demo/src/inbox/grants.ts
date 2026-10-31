import type { Grant, Grants } from "@novadeck/core/grants"
import type { InboxAnswer, InboxRow } from "@novadeck/core/inbox"
import { createStore } from "@novadeck/core/store"

// The demo's grants: made from the Grant and approval cards' answers as the runner makes them,
// listed while they last, and gone when revoked or ended.

const hour = 3_600_000

export type DemoGrants = Grants & {
  // A grant of the demo's own appears, as one the runner made.
  readonly add: (grant: Grant) => void
  // A grant ends by its time, with no revoke: it leaves the list.
  readonly end: (id: string) => void
  // The grant's terminal ran a command it allowed.
  readonly use: (id: string, use: NonNullable<Grant["lastUse"]>) => void
  // Every grant leaves.
  readonly empty: () => void
}

export const createDemoGrants = (): DemoGrants => {
  const state = createStore<readonly Grant[]>([])
  const drop = (id: string): void => {
    state.update((current) => current.filter((each) => each.id !== id))
  }
  return {
    state,
    add: (grant) =>
      state.update((current) => [...current.filter((each) => each.id !== grant.id), grant]),
    end: drop,
    revoke: drop,
    use: (id, lastUse) =>
      state.update((current) =>
        current.map((each) => (each.id === id ? { ...each, lastUse } : each)),
      ),
    empty: () => state.update(() => []),
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
      endsAt: now + picked.hours * hour,
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
      holder: { kind: "terminal", handle: source.handle },
      presets: [],
      commands: [...row.ask.shape.commands],
      repos: [],
      endsAt: now + (row.ask.shape.hours ?? 1) * hour,
    }
  return undefined
}
