import type { Backend, TerminalKey } from "@novadeck/core/port"
import type { WorkspaceSeed } from "@novadeck/core/seed"
import { createStore } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"
import type { Work, WorkConflict, WorkFile, Works, WorksState } from "@novadeck/core/works"

import type { DemoTurns } from "./agents/turns"
import { terminalOf } from "./workspace"

// The demo's Changes: each terminal's work against main, from fixtures planned per demo
// (`WorkPlan`) and kept by the demo's own store, standing in for the runner, which reads the
// terminals' checkouts. Looking at a work reads it; a demo agent that works gains a few
// unread lines in its work; the debug panel changes the rest (see `DemoWorksControl`).

const minute = 60_000

// A file of a plan: what it changes, and how much of that is still unread.
export type FilePlan = {
  readonly path: string
  readonly added: number
  readonly removed: number
  // Read: none of its lines are unread. Otherwise `unread` is the share of them that is
  // (all of them by default).
  readonly read?: true
  readonly unread?: number
  readonly conflict?: true
}

export const planFile = (
  path: string,
  added: number,
  removed: number,
  rest: Omit<FilePlan, "path" | "added" | "removed"> = {},
): FilePlan => ({ path, added, removed, ...rest })

// A work a demo opens with. The terminal is named by its title, in the project the plan
// names, and a conflict with another work by that terminal's title in the same project.
export type WorkPlan = {
  readonly project: string
  readonly terminal: string
  // How long ago it first differed from main.
  readonly minutesAgo: number
  readonly files: readonly FilePlan[]
  readonly conflicts?: readonly string[]
}

const fileOf = (plan: FilePlan): WorkFile => {
  const share = plan.read ? 0 : (plan.unread ?? 1)
  return {
    path: plan.path,
    added: plan.added,
    removed: plan.removed,
    unreadAdded: Math.round(plan.added * share),
    unreadRemoved: Math.round(plan.removed * share),
    conflict: plan.conflict === true,
  }
}

// A work's sums over its files; the files themselves stay as they are.
const summed = (work: Work, files: readonly WorkFile[]): Work => ({
  ...work,
  files,
  added: files.reduce((sum, file) => sum + file.added, 0),
  removed: files.reduce((sum, file) => sum + file.removed, 0),
  unreadAdded: files.reduce((sum, file) => sum + file.unreadAdded, 0),
  unreadRemoved: files.reduce((sum, file) => sum + file.unreadRemoved, 0),
})

export type Placed = {
  readonly projectId: string
  readonly terminalId: string
  readonly root: string
}

// Where a terminal of the seed is: its project and its folder.
const placeOf = (seed: WorkspaceSeed, project: string, title: string): Placed | undefined => {
  const found = seed.projects.find((each) => each.id === project)
  const terminal = found?.sessions
    .flatMap((session) => session.terminals)
    .find((each) => each.name === title)
  return found && terminal
    ? { projectId: found.id, terminalId: terminal.id, root: terminal.directory }
    : undefined
}

// The works a demo opens with, from its plans and its own seed. A plan that names a project
// or terminal the seed lacks has no work; a conflict between two works is on both.
export const worksFromPlans = (
  seed: WorkspaceSeed,
  plans: readonly WorkPlan[],
  now: number,
): readonly Work[] => {
  const placed = plans.flatMap((plan) => {
    const at = placeOf(seed, plan.project, plan.terminal)
    return at ? [{ plan, at }] : []
  })
  const idOf = (project: string, title: string): string | undefined =>
    placed.find(({ plan }) => plan.project === project && plan.terminal === title)?.at.terminalId
  return placed.map(({ plan, at }) => {
    const others = placed.flatMap(({ plan: other, at: elsewhere }) =>
      other.project === plan.project &&
      elsewhere.terminalId !== at.terminalId &&
      other.conflicts?.includes(plan.terminal)
        ? [elsewhere.terminalId]
        : [],
    )
    const own = (plan.conflicts ?? []).flatMap((title) =>
      title === "main" ? [] : [idOf(plan.project, title)].filter((id) => id !== undefined),
    )
    const conflicts: WorkConflict[] = [
      ...(plan.conflicts?.includes("main") ? [{ with: "main" as const }] : []),
      ...[...new Set([...own, ...others])].map((terminalId) => ({
        with: "work" as const,
        terminalId,
      })),
    ]
    return summed(
      {
        ...at,
        branch: `agent/${plan.terminal.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        base: "main",
        firstSeenAt: now - plan.minutesAgo * minute,
        added: 0,
        removed: 0,
        unreadAdded: 0,
        unreadRemoved: 0,
        files: [],
        truncated: false,
        conflicts,
      },
      plan.files.map(fileOf),
    )
  })
}

// ---- Changes to a work, as pure steps ----

// Lines it gains, all unread: in its first file, or in a file of its own when it has none.
export const gained = (work: Work, lines: number): Work => {
  const [first, ...rest] = work.files
  const file: WorkFile = first
    ? {
        ...first,
        added: first.added + lines,
        unreadAdded: first.unreadAdded + lines,
      }
    : {
        path: "NOTES.md",
        added: lines,
        removed: 0,
        unreadAdded: lines,
        unreadRemoved: 0,
        conflict: false,
      }
  return summed(work, [file, ...rest])
}

// It changes `count` more files, all unread: more than its row can list.
export const spread = (work: Work, count: number): Work =>
  summed(work, [
    ...work.files,
    ...Array.from({ length: count }, (_, index): WorkFile => {
      const lines = 6 + ((index * 7) % 23)
      return {
        path: `src/generated/part-${work.files.length + index + 1}.ts`,
        added: lines,
        removed: index % 3,
        unreadAdded: lines,
        unreadRemoved: index % 3,
        conflict: false,
      }
    }),
  ])

// It has been read as it is.
export const looked = (work: Work): Work =>
  summed(
    work,
    work.files.map((file) => ({ ...file, unreadAdded: 0, unreadRemoved: 0 })),
  )

// It conflicts with main, in its first file.
export const conflictedWithMain = (work: Work): Work => {
  const [first, ...rest] = work.files
  return {
    ...summed(work, first ? [{ ...first, conflict: true }, ...rest] : []),
    conflicts: [{ with: "main" }, ...work.conflicts.filter((conflict) => conflict.with !== "main")],
  }
}

const withConflict = (work: Work, other: string): Work => {
  const [first, ...rest] = work.files
  return {
    ...summed(work, first ? [{ ...first, conflict: true }, ...rest] : []),
    conflicts: [
      ...work.conflicts.filter(
        (conflict) => conflict.with === "main" || conflict.terminalId !== other,
      ),
      { with: "work", terminalId: other },
    ],
  }
}

// It no longer conflicts with anything.
export const settled = (work: Work): Work => ({
  ...summed(
    work,
    work.files.map((file) => ({ ...file, conflict: false })),
  ),
  conflicts: [],
})

// ---- The store ----

// What the debug panel changes. A terminal without a work gets one at its first change, as the
// runner's does at the first edit.
export type DemoWorksControl = {
  readonly gain: (at: Placed, lines?: number) => void
  // The work changes `count` more files.
  readonly spread: (at: Placed, count: number) => void
  readonly conflictWithMain: (at: Placed) => void
  // The work conflicts with another terminal's, which gets a work of its own to conflict with.
  readonly conflictBetween: (at: Placed, other: Placed) => void
  readonly settle: (terminalId: string) => void
  // The work leaves the list: merged into main, or discarded.
  readonly end: (terminalId: string) => void
  readonly worksOf: (projectId: string) => readonly Work[]
}

export type DemoWorks = Works & DemoWorksControl

export const isDemoWorks = (works: Backend["works"]): works is DemoWorks =>
  works !== undefined && "conflictBetween" in works && "gain" in works && "spread" in works

// How many lines a working agent's turn adds to its work.
const turnLines = 14

export const createDemoWorks = (
  initial: readonly Work[],
  options: {
    readonly now?: () => number
    // The item a work shows as, where the demo has a companion pane that can; null where not.
    readonly show?: (work: Work) => Promise<string | null>
  } = {},
): DemoWorks => {
  const { now = Date.now, show } = options
  const state = createStore<WorksState>({ works: initial })
  const change = (terminalId: string, step: (work: Work) => Work): void => {
    state.update((current) => ({
      works: current.works.map((work) => (work.terminalId === terminalId ? step(work) : work)),
    }))
  }
  const find = (terminalId: string): Work | undefined =>
    state.getSnapshot().works.find((work) => work.terminalId === terminalId)
  // The work of a terminal, made at its first change.
  const ensure = (at: Placed): void => {
    if (find(at.terminalId)) return
    const fresh: Work = {
      ...at,
      branch: null,
      base: "main",
      firstSeenAt: now(),
      added: 0,
      removed: 0,
      unreadAdded: 0,
      unreadRemoved: 0,
      files: [],
      truncated: false,
      conflicts: [],
    }
    state.update((current) => ({ works: [...current.works, fresh] }))
  }
  return {
    state,
    look: (terminalId) => change(terminalId, looked),
    show: (terminalId) => {
      const work = find(terminalId)
      return work && show ? show(work) : Promise.resolve(null)
    },
    gain: (at, lines = turnLines) => {
      ensure(at)
      change(at.terminalId, (work) => gained(work, lines))
    },
    spread: (at, count) => {
      ensure(at)
      change(at.terminalId, (work) => spread(work, count))
    },
    conflictWithMain: (at) => {
      ensure(at)
      if (find(at.terminalId)?.files.length === 0) change(at.terminalId, (work) => gained(work, 12))
      change(at.terminalId, conflictedWithMain)
    },
    conflictBetween: (at, other) => {
      for (const each of [at, other]) {
        ensure(each)
        if (find(each.terminalId)?.files.length === 0)
          change(each.terminalId, (work) => gained(work, 12))
      }
      change(at.terminalId, (work) => withConflict(work, other.terminalId))
      change(other.terminalId, (work) => withConflict(work, at.terminalId))
    },
    settle: (terminalId) => change(terminalId, settled),
    end: (terminalId) =>
      state.update((current) => ({
        // Whoever conflicted with it no longer does.
        works: current.works
          .filter((work) => work.terminalId !== terminalId)
          .map((work) => {
            const conflicts = work.conflicts.filter(
              (conflict) => conflict.with === "main" || conflict.terminalId !== terminalId,
            )
            return conflicts.length === work.conflicts.length ? work : { ...work, conflicts }
          }),
      })),
    worksOf: (projectId) =>
      state.getSnapshot().works.filter((work) => work.projectId === projectId),
  }
}

// A backend with the demo's Changes. A demo agent that starts a turn gains lines in its work
// (its first change makes the work), once per turn; `show` is what a work shows as.
export const withWorks = (
  backend: Backend,
  options: {
    readonly plans?: readonly WorkPlan[]
    readonly turns?: DemoTurns
    readonly show?: (work: Work, workspace: Workspace | undefined) => Promise<string | null>
  } = {},
): Backend => {
  const { plans = [], turns, show } = options
  let latest: Workspace | undefined
  const works = createDemoWorks(worksFromPlans(backend.seed, plans, Date.now()), {
    ...(show && { show: (work: Work) => show(work, latest) }),
  })
  // The agents that work now, so a turn adds its lines once as it starts.
  const working = new Set<string>()
  turns?.watchStatus((key: TerminalKey, agent) => {
    const active = agent.working && !agent.attention
    if (!active) return void working.delete(key.terminalId)
    if (working.has(key.terminalId)) return
    working.add(key.terminalId)
    const terminal = terminalOf(latest, key)
    works.gain({
      projectId: key.projectId,
      terminalId: key.terminalId,
      root: terminal?.directory ?? "~",
    })
  })
  return {
    ...backend,
    works,
    commit: (workspace, actions) => {
      latest = workspace
      backend.commit(workspace, actions)
    },
  }
}
