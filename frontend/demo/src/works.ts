import type { Backend, TerminalKey } from "@novadeck/core/port"
import type { WorkspaceSeed } from "@novadeck/core/seed"
import { createStore } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"
import type { Work, WorkConflict, WorkFile, Works, WorksState } from "@novadeck/core/works"

import type { DemoTurns } from "./agents/turns"

// The demo's Changes: each tracked worktree's work against main, from fixtures planned per demo
// (`WorkPlan`) and kept by the demo's own store, standing in for the runner, which reads the
// worktrees its table tracks. A work has an owner terminal or none. Looking at a work reads
// it; closing one removes it (refusing while its owner's agent works in it, or when the
// debug panel armed a refusal); a demo agent that works gains a few unread lines in its
// first work and holds it busy; the debug panel changes the rest (see `DemoWorksControl`).

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

// A work a demo opens with: a worktree of the project the plan names. Its owner is named by
// its terminal's title, or null for a worktree with no owner; a conflict with another work
// is named by its owner's title in the same project, or "main".
export type WorkPlan = {
  readonly project: string
  readonly terminal: string | null
  // Its branch; the owner's title as a branch when left out.
  readonly branch?: string
  // How long ago it first differed from main.
  readonly minutesAgo: number
  // None: the worktree differs from nothing, so closing it asks no question.
  readonly files: readonly FilePlan[]
  readonly conflicts?: readonly string[]
  // The owner's agent is mid-turn in it, so its × waits.
  readonly working?: true
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

// Where a terminal's work is made when it has none: its project, its id, and the root of the
// worktree.
export type Placed = {
  readonly projectId: string
  readonly terminalId: string
  readonly root: string
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-")

// The folder of a worktree of a project, as the runner places it: its group, then its repository.
export const worktreeRoot = (project: string, group: string): string =>
  `~/.novadeck/worktrees/${project}/${slug(group)}/${project}`

// The works a demo opens with, from its plans and its own seed. A plan that names a project
// or terminal the seed lacks has no work; a conflict between two works is on both.
export const worksFromPlans = (
  seed: WorkspaceSeed,
  plans: readonly WorkPlan[],
  now: number,
): readonly Work[] => {
  const placed = plans.flatMap((plan) => {
    const project = seed.projects.find((each) => each.id === plan.project)
    const terminal =
      plan.terminal === null
        ? undefined
        : project?.sessions
            .flatMap((session) => session.terminals)
            .find((each) => each.name === plan.terminal)
    if (!project || (plan.terminal !== null && !terminal)) return []
    const branch = plan.branch ?? `agent/${slug(plan.terminal ?? "unowned")}`
    return [
      {
        plan,
        projectId: project.id,
        terminalId: terminal?.id ?? null,
        branch,
        root: worktreeRoot(project.id, branch),
      },
    ]
  })
  const ownedBy = (project: string, title: string) =>
    placed.find((each) => each.plan.project === project && each.plan.terminal === title)
  return placed.map((at) => {
    const { plan } = at
    const others = placed.filter(
      (other) =>
        other.projectId === at.projectId &&
        other.root !== at.root &&
        plan.terminal !== null &&
        other.plan.conflicts?.includes(plan.terminal),
    )
    const own = (plan.conflicts ?? []).flatMap((title) => {
      const found = title === "main" ? undefined : ownedBy(plan.project, title)
      return found ? [found] : []
    })
    const conflicts: WorkConflict[] = [
      ...(plan.conflicts?.includes("main") ? [{ with: "main" as const }] : []),
      ...[...new Set([...own, ...others])].map((other) => ({
        with: "work" as const,
        root: other.root,
        terminalId: other.terminalId,
      })),
    ]
    return summed(
      {
        root: at.root,
        terminalId: at.terminalId,
        projectId: at.projectId,
        working: plan.working === true,
        branch: at.branch,
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

// It changes `count` more files, all unread, more than the work lists.
export const spread = (work: Work, count: number): Work => ({
  ...summed(work, [
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
  ]),
  // So many files that the work lists only some: the row says "and more".
  truncated: true,
})

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

const withConflict = (work: Work, other: Work): Work => {
  const [first, ...rest] = work.files
  return {
    ...summed(work, first ? [{ ...first, conflict: true }, ...rest] : []),
    conflicts: [
      ...work.conflicts.filter(
        (conflict) => conflict.with === "main" || conflict.root !== other.root,
      ),
      { with: "work", root: other.root, terminalId: other.terminalId },
    ],
  }
}

// Nothing differs from main any more: merged into it, or discarded. The worktree stays.
export const merged = (work: Work): Work => ({
  ...summed(work, []),
  conflicts: [],
  truncated: false,
})

// It no longer conflicts with anything.
export const settled = (work: Work): Work => ({
  ...summed(
    work,
    work.files.map((file) => ({ ...file, conflict: false })),
  ),
  conflicts: [],
})

// ---- The store ----

// Why a close the debug panel armed is refused.
export const closeRefusal =
  "Novadeck couldn't read the worktree's git status, so it stays. Try again in a moment."

// What the debug panel changes. A terminal without a work gets a worktree at its first change,
// at the root `Placed` names; one that has works changes its first.
export type DemoWorksControl = {
  readonly gain: (at: Placed, lines?: number) => void
  // The work changes `count` more files.
  readonly spread: (at: Placed, count: number) => void
  readonly conflictWithMain: (at: Placed) => void
  // The work conflicts with another terminal's, which gets a work of its own to conflict with.
  readonly conflictBetween: (at: Placed, other: Placed) => void
  readonly settle: (root: string) => void
  // The work differs from nothing: merged into main, or discarded. The worktree stays.
  readonly merge: (root: string) => void
  // The terminal's worktree, just made: it differs from nothing.
  readonly openClean: (at: Placed) => void
  // The worktree has no owner.
  readonly orphan: (root: string) => void
  // The owner's agent is mid-turn in the terminal's first worktree, or no longer.
  readonly setWorking: (terminalId: string, working: boolean) => void
  // The next close is refused, as when git status couldn't be read.
  readonly refuseNextClose: () => void
  // The worktree is closed, by the debug panel rather than the person.
  readonly remove: (root: string) => void
  // Every worktree of the project is closed.
  readonly removeAll: (projectId: string) => void
  readonly ownedBy: (terminalId: string) => Work | undefined
  readonly worksOf: (projectId: string) => readonly Work[]
}

export type DemoWorks = Works & DemoWorksControl

export const isDemoWorks = (works: Backend["works"]): works is DemoWorks =>
  works !== undefined && "conflictBetween" in works && "gain" in works && "spread" in works

// How many lines a working agent's turn adds to its work.
const turnLines = 14

// The works without the one at `root`, and no conflict with it left on the others.
const drop = (current: WorksState, root: string): WorksState => ({
  ...current,
  // Whoever conflicted with it no longer does.
  works: current.works
    .filter((work) => work.root !== root)
    .map((work) => {
      const conflicts = work.conflicts.filter(
        (conflict) => conflict.with === "main" || conflict.root !== root,
      )
      return conflicts.length === work.conflicts.length ? work : { ...work, conflicts }
    }),
})

export const createDemoWorks = (
  initial: readonly Work[],
  options: {
    readonly now?: () => number
    // The item a work shows as, on the terminal's bar; null where the demo has no companion
    // pane that can.
    readonly show?: (work: Work, terminalId: string) => Promise<string | null>
  } = {},
): DemoWorks => {
  const { now = Date.now, show } = options
  const state = createStore<WorksState>({ works: initial, synced: true })
  let refuse = false
  const change = (root: string, step: (work: Work) => Work): void => {
    state.update((current) => ({
      ...current,
      works: current.works.map((work) => (work.root === root ? step(work) : work)),
    }))
  }
  const find = (root: string): Work | undefined =>
    state.getSnapshot().works.find((work) => work.root === root)
  const ownedBy = (terminalId: string): Work | undefined =>
    state.getSnapshot().works.find((work) => work.terminalId === terminalId)
  // The work of a terminal, made at its first change.
  const ensure = (at: Placed): Work => {
    const own = ownedBy(at.terminalId)
    if (own) return own
    const fresh: Work = {
      root: at.root,
      terminalId: at.terminalId,
      projectId: at.projectId,
      working: false,
      branch: `agent/${slug(at.terminalId)}`,
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
    state.update((current) => ({ ...current, works: [...current.works, fresh] }))
    return fresh
  }
  return {
    state,
    // The demo's works are always current.
    watch: () => () => {},
    look: (root) => change(root, looked),
    show: (root, terminalId) => {
      const work = find(root)
      const on = work?.terminalId ?? terminalId
      return work && show && on !== undefined ? show(work, on) : Promise.resolve(null)
    },
    close: async (root, force = false) => {
      const work = find(root)
      if (!work) throw new Error("Novadeck no longer tracks that worktree.")
      if (work.working)
        throw new Error(
          "Its agent is working in that worktree right now: wait for its turn to end.",
        )
      if (refuse) {
        refuse = false
        throw new Error(closeRefusal)
      }
      const holds = work.files.length > 0 || work.truncated
      if (holds && !force)
        throw new Error(
          `The worktree holds ${work.files.length} changed file${work.files.length === 1 ? "" : "s"}, so it stays.`,
        )
      state.update((current) => drop(current, root))
      return {
        ...(holds && { kept: `refs/novadeck/kept/${work.branch ?? "detached"}` }),
        branchDeleted: !holds,
      }
    },
    gain: (at, lines = turnLines) => {
      const { root } = ensure(at)
      change(root, (work) => gained(work, lines))
    },
    spread: (at, count) => {
      const { root } = ensure(at)
      change(root, (work) => spread(work, count))
    },
    conflictWithMain: (at) => {
      const { root } = ensure(at)
      if (find(root)?.files.length === 0) change(root, (work) => gained(work, 12))
      change(root, conflictedWithMain)
    },
    conflictBetween: (at, other) => {
      const roots = [at, other].map((each) => ensure(each).root) as [string, string]
      for (const root of roots)
        if (find(root)?.files.length === 0) change(root, (w) => gained(w, 12))
      const [mine, theirs] = roots.map((root) => find(root)!) as [Work, Work]
      change(mine.root, (work) => withConflict(work, theirs))
      change(theirs.root, (work) => withConflict(work, mine))
    },
    settle: (root) => change(root, settled),
    merge: (root) =>
      state.update((current) => ({
        ...current,
        works: current.works.map((work) =>
          work.root === root
            ? merged(work)
            : {
                ...work,
                conflicts: work.conflicts.filter(
                  (conflict) => conflict.with === "main" || conflict.root !== root,
                ),
              },
        ),
      })),
    openClean: (at) => {
      const { root } = ensure(at)
      change(root, merged)
    },
    orphan: (root) => change(root, (work) => ({ ...work, terminalId: null, working: false })),
    setWorking: (terminalId, working) => {
      const own = ownedBy(terminalId)
      if (own && own.working !== working) change(own.root, (work) => ({ ...work, working }))
    },
    refuseNextClose: () => {
      refuse = true
    },
    remove: (root) => state.update((current) => drop(current, root)),
    removeAll: (projectId) =>
      state.update((current) => ({
        ...current,
        works: current.works.filter((work) => work.projectId !== projectId),
      })),
    ownedBy,
    worksOf: (projectId) =>
      state.getSnapshot().works.filter((work) => work.projectId === projectId),
  }
}

// A backend with the demo's Changes. A demo agent that starts a turn gains lines in the first
// work it owns, once per turn, and holds it busy until the turn ends; one that owns none
// changes nothing. `show` is what a work shows as.
export const withWorks = (
  backend: Backend,
  options: {
    readonly plans?: readonly WorkPlan[]
    readonly turns?: DemoTurns
    readonly show?: (
      work: Work,
      terminalId: string,
      workspace: Workspace | undefined,
    ) => Promise<string | null>
  } = {},
): Backend => {
  const { plans = [], turns, show } = options
  let latest: Workspace | undefined
  const works = createDemoWorks(worksFromPlans(backend.seed, plans, Date.now()), {
    ...(show && {
      show: (work: Work, terminalId: string) => show(work, terminalId, latest),
    }),
  })
  // The agents that work now, so a turn adds its lines once as it starts.
  const working = new Set<string>()
  turns?.watchStatus((key: TerminalKey, agent) => {
    const active = agent.working && !agent.attention
    if (!active) {
      if (working.delete(key.terminalId)) works.setWorking(key.terminalId, false)
      return
    }
    if (working.has(key.terminalId)) return
    working.add(key.terminalId)
    const own = works.ownedBy(key.terminalId)
    if (!own) return
    works.gain({ projectId: key.projectId, terminalId: key.terminalId, root: own.root })
    works.setWorking(key.terminalId, true)
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
