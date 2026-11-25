import type { PullRequest, PullRequestCheck } from "@novadeck/core/forges"
import type { Backend, TerminalKey } from "@novadeck/core/port"
import type { WorkspaceSeed } from "@novadeck/core/seed"
import { createStore, type Store } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"
import {
  madeOne,
  type Work,
  type WorkConflict,
  type WorkFile,
  type Works,
  type WorksMade,
  type WorkPreview,
  type WorksState,
} from "@novadeck/core/works"

import type { DemoTurns } from "./agents/turns"
import { isDemoFiles, terminalOfHandle } from "./files"
import { demoHandle } from "./handles"
import {
  addedPath,
  createDemoPreview,
  previewPath,
  renamedPath,
  renamedTo,
  type DemoPreview,
  type OwlChange,
  type PreviewScenario,
} from "./preview"

// The demo's works: each tracked worktree's work against main, from fixtures planned per demo
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
  // How it changed; modified when left out.
  readonly status?: WorkFile["status"]
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
  // How long ago its repository's origin was last fetched, so main is that old; left out: never.
  readonly fetchedMinutesAgo?: number
  // None: the worktree differs from nothing, so closing it asks no question.
  readonly files: readonly FilePlan[]
  // With no files: its work was merged (else the worktree was just made).
  readonly merged?: true
  readonly conflicts?: readonly string[]
  // The owner's agent is mid-turn in it, so its trash button waits.
  readonly working?: true
  // Its pull request on the forge, as the row's mark shows it, and how its checks and review
  // stand where it is open (none ran, and none asked for, when left out).
  readonly pullRequest?: {
    readonly number: number
    readonly state: PullRequest["state"]
    readonly ci?: PullRequest["ci"]
    readonly review?: PullRequest["review"]
  }
  // How many paths hold changes not committed: as many as the plan has files, or none for a
  // merged one, when left out.
  readonly uncommitted?: number
  // How many of its commits no remote holds; none when left out.
  readonly unpushed?: number
}

// The checks of a demo pull request whose checks stand so, one by one: the same four pipelines,
// each as far along as `ci` says.
const demoChecks: Readonly<
  Record<NonNullable<PullRequest["ci"]>, readonly PullRequestCheck[] | undefined>
> = {
  none: undefined,
  passed: [
    { name: "lint", state: "passed" },
    { name: "typecheck", state: "passed" },
    { name: "test (linux)", state: "passed" },
    { name: "test (macos)", state: "passed" },
  ],
  running: [
    { name: "lint", state: "passed" },
    { name: "typecheck", state: "passed" },
    { name: "test (linux)", state: "running" },
    { name: "test (macos)", state: "waiting" },
  ],
  failing: [
    { name: "lint", state: "passed" },
    { name: "typecheck", state: "passed" },
    { name: "test (linux)", state: "failed" },
    { name: "test (macos)", state: "passed" },
  ],
}

// A pull request of the demo's: its page is on the forge's host, which no one opens. It
// targets main. Only an open one (or a draft) has checks and a review: none ran when `ci` is
// left out, and none was asked for when `review` is.
export const demoPullRequest = (
  number: number,
  state: PullRequest["state"],
  title = `Change ${number}`,
  ci: NonNullable<PullRequest["ci"]> = "none",
  review: NonNullable<PullRequest["review"]> = "none",
): PullRequest => {
  const open = state === "open" || state === "draft"
  const checks = open ? demoChecks[ci] : undefined
  return {
    number,
    state,
    title,
    url: `https://github.com/novadeck-demo/storefront/pull/${number}`,
    base: "main",
    ...(open && { ci, review }),
    ...(checks && { checks }),
  }
}

// Whether closing a work leaves nothing that lives only there, by the runner's rule: merged with
// nothing uncommitted, or its pull request closed with nothing uncommitted or unpushed; never
// while its pull request is open or a draft. A merged work ignores `unpushed`: its remote
// branch is often deleted after a squash merge.
export const safeOf = (
  work: Pick<Work, "merged" | "uncommitted" | "unpushed" | "pullRequest">,
): boolean => {
  const { merged, uncommitted = 0, unpushed = 0, pullRequest } = work
  if (pullRequest?.state === "open" || pullRequest?.state === "draft") return false
  return (
    (merged && uncommitted === 0) ||
    (pullRequest?.state === "closed" && uncommitted === 0 && unpushed === 0)
  )
}

// The work with its `safe` as its other fields make it.
const standing = (work: Work): Work => ({ ...work, safe: safeOf(work) })

const fileOf = (plan: FilePlan, changedAt: number): WorkFile => {
  const share = plan.read ? 0 : (plan.unread ?? 1)
  return {
    path: plan.path,
    status: plan.status ?? "modified",
    changedAt,
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
  // A merged work that changes a file is no longer merged.
  merged: work.merged && files.length === 0,
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
    return standing(
      summed(
        {
          root: at.root,
          terminalId: at.terminalId,
          projectId: at.projectId,
          working: plan.working === true,
          branch: at.branch,
          base: "main",
          ...(plan.fetchedMinutesAgo !== undefined && {
            fetchedAt: now - plan.fetchedMinutesAgo * minute,
          }),
          firstSeenAt: now - plan.minutesAgo * minute,
          merged: plan.merged === true,
          added: 0,
          removed: 0,
          unreadAdded: 0,
          unreadRemoved: 0,
          files: [],
          truncated: false,
          folder: { repo: "", project: "" },
          conflicts,
          uncommitted: plan.uncommitted ?? (plan.merged ? 0 : plan.files.length),
          unpushed: plan.unpushed ?? 0,
          ...(plan.pullRequest && {
            pullRequest: demoPullRequest(
              plan.pullRequest.number,
              plan.pullRequest.state,
              undefined,
              plan.pullRequest.ci,
              plan.pullRequest.review,
            ),
          }),
        },
        plan.files.map((file) => fileOf(file, now - plan.minutesAgo * minute)),
      ),
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
        status: "added",
        changedAt: work.firstSeenAt,
        added: lines,
        removed: 0,
        unreadAdded: lines,
        unreadRemoved: 0,
        conflict: false,
      }
  return {
    ...summed(work, [file, ...rest]),
    // A file of its own is one more not committed.
    uncommitted: (work.uncommitted ?? 0) + (first ? 0 : 1),
  }
}

// It changes `count` more files, all unread, more than the work lists.
export const spread = (work: Work, count: number): Work => ({
  ...summed(work, [
    ...work.files,
    ...Array.from({ length: count }, (_, index): WorkFile => {
      const lines = 6 + ((index * 7) % 23)
      return {
        path: `src/generated/part-${work.files.length + index + 1}.ts`,
        status: "added",
        changedAt: work.firstSeenAt,
        added: lines,
        removed: index % 3,
        unreadAdded: lines,
        unreadRemoved: index % 3,
        conflict: false,
      }
    }),
  ]),
  uncommitted: (work.uncommitted ?? 0) + count,
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

// Nothing differs from main any more, and the worktree has commits of its own: merged into it.
// The worktree stays.
// Its own commits stay unpushed, as after a squash merge deleted the remote branch.
export const merged = (work: Work): Work => ({
  ...emptied(work),
  merged: true,
  unpushed: 1,
})

// Nothing differs from main, as in a worktree just made.
export const emptied = (work: Work): Work => ({
  ...summed(work, []),
  merged: false,
  conflicts: [],
  truncated: false,
  uncommitted: 0,
  unpushed: 0,
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
  // The terminal's worktree on `branch`, just made (the tour's teammates open theirs so): it differs
  // from nothing; none is made where the terminal has one.
  readonly openBranch: (at: Placed, branch: string) => void
  // The terminal's work changes exactly these files, as of `at`: what an agent's edit leaves.
  readonly setFiles: (terminalId: string, files: readonly FilePlan[], at: number) => void
  // The work changes `count` more files.
  readonly spread: (at: Placed, count: number) => void
  readonly conflictWithMain: (at: Placed) => void
  // The work conflicts with another terminal's, which gets a work of its own to conflict with.
  readonly conflictBetween: (at: Placed, other: Placed) => void
  readonly settle: (root: string) => void
  // The work was merged into main: it differs from nothing, and the worktree stays.
  readonly merge: (root: string) => void
  // The terminal's worktree, just made: it differs from nothing.
  readonly openClean: (at: Placed) => void
  // Another worktree of the terminal's, just made beside the ones it has: a new one each call.
  readonly makeAnother: (at: Placed) => void
  // The work's pull request, found on the forge in this state (numbered 812 where it had none),
  // or none found.
  readonly setPullRequest: (root: string, state: PullRequest["state"] | undefined) => void
  // The worktree has no owner.
  readonly orphan: (root: string) => void
  // Its owner is closed, in History: the row still names an owner, no terminal of the project.
  readonly ownerClosed: (root: string) => void
  // The work of the terminal changes `path` (as it did when `at`): added to its files where
  // it had none, else its time moved on, as a runner's does at each new write.
  readonly touchFile: (
    terminalId: string,
    path: string,
    at: number,
    extra?: Partial<WorkFile>,
  ) => void
  // The storefront's third agent changes src/checkout/Checkout.tsx, as the file preview shows
  // it, in a clash with the others or in lines main has rewritten since; or no longer.
  readonly previewOwl: (change: OwlChange | undefined) => void
  // Crow adds src/checkout/OrderSummary.tsx too (which Moth adds), or renames
  // src/checkout/PaymentStep.tsx to src/checkout/PaymentForm.tsx (which Moth modifies), or no
  // longer.
  readonly previewScenario: (which: PreviewScenario, on: boolean) => void
  // The terminal's worktree differs from nothing but has `count` commits main lacks (and no
  // remote holds); it is not merged, so closing it asks.
  readonly commitsMainLacks: (at: Placed, count: number) => void
  // The work's pull request has its checks in this state (an open one made where it had none
  // or was done).
  readonly setCi: (root: string, ci: NonNullable<PullRequest["ci"]>) => void
  // The work's pull request's review stands so (an open one made where it had none or was done).
  readonly setReview: (root: string, review: NonNullable<PullRequest["review"]>) => void
  // The terminal's worktree holds `count` uncommitted paths, whatever else it is.
  readonly setUncommitted: (at: Placed, count: number) => void
  // The terminal's worktree belongs on the branch `home` (not main), or on main again.
  readonly setHome: (at: Placed, home: string | undefined) => void
  // The terminal's worktree has `count` commits no remote holds.
  readonly setUnpushed: (at: Placed, count: number) => void
  // The terminal's worktree's origin was last fetched `minutes` ago.
  readonly fetchedAgo: (at: Placed, minutes: number) => void
  // The owner's agent is mid-turn in the terminal's first worktree, or no longer.
  readonly setWorking: (terminalId: string, working: boolean) => void
  // The next close is refused, as when git status couldn't be read.
  readonly refuseNextClose: () => void
  // For `ms`, the works are as before a runner first reports them: none, and not reported. Then
  // they come back as they were; called again meanwhile, from then on.
  readonly unreported: (ms: number) => void
  // The worktree is closed, by the debug panel rather than the person.
  readonly remove: (root: string) => void
  // Every worktree of the project is closed.
  readonly removeAll: (projectId: string) => void
  readonly ownedBy: (terminalId: string) => Work | undefined
  readonly worksOf: (projectId: string) => readonly Work[]
}

export type DemoWorks = Works & DemoWorksControl & { readonly made: Store<WorksMade> }

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
    // What a file previews as; a backend with none previews nothing.
    readonly preview?: DemoPreview
    // Has the Files panel show an agent's change to a file, by its handle, or no longer.
    readonly mark?: (
      handle: string,
      path: string,
      kind: "modified" | "added" | "deleted" | undefined,
    ) => void
  } = {},
): DemoWorks => {
  const { now = Date.now, show, preview, mark } = options
  const state = createStore<WorksState>({ works: initial, synced: true, reported: true })
  // How many worktrees were made since the demo began, by project, which the Worktrees toggle
  // flares for while their project is open.
  const made = createStore<WorksMade>(new Map())
  // How many extra worktrees the debug panel made, to name each one apart.
  let extras = 0
  let refuse = false
  // The works `unreported` holds back, and when they come back.
  let held: { works: readonly Work[]; timer: ReturnType<typeof setTimeout> } | undefined
  // The commits main lacks of worktrees that differ from it in no file, by root.
  const unmerged = new Map<string, number>()
  const change = (root: string, step: (work: Work) => Work): void => {
    state.update((current) => ({
      ...current,
      works: current.works.map((work) => (work.root === root ? standing(step(work)) : work)),
    }))
  }
  const find = (root: string): Work | undefined =>
    state.getSnapshot().works.find((work) => work.root === root)
  const ownedBy = (terminalId: string): Work | undefined =>
    state.getSnapshot().works.find((work) => work.terminalId === terminalId)
  // A worktree just made: it differs from nothing. It counts as made.
  const make = (at: Placed, name = slug(at.terminalId), branch = `agent/${name}`): Work => {
    const fresh: Work = {
      root: at.root,
      terminalId: at.terminalId,
      projectId: at.projectId,
      working: false,
      branch,
      base: "main",
      firstSeenAt: now(),
      merged: false,
      added: 0,
      removed: 0,
      unreadAdded: 0,
      unreadRemoved: 0,
      files: [],
      truncated: false,
      folder: { repo: "", project: "" },
      conflicts: [],
      uncommitted: 0,
      unpushed: 0,
      safe: false,
    }
    state.update((current) => ({ ...current, works: [...current.works, fresh] }))
    made.update((counts) => madeOne(counts, at.projectId))
    return fresh
  }
  const touchFile = (
    terminalId: string,
    path: string,
    at: number,
    extra: Partial<WorkFile> = {},
  ): void => {
    const own = ownedBy(terminalId)
    if (!own) return
    const file: WorkFile = {
      path,
      status: "modified",
      changedAt: at,
      added: 1,
      removed: 1,
      unreadAdded: 1,
      unreadRemoved: 1,
      conflict: false,
      ...extra,
    }
    change(own.root, (work) =>
      summed(
        work,
        work.files.some((each) => each.path === path)
          ? work.files.map((each) => (each.path === path ? { ...each, changedAt: at } : each))
          : [...work.files, file],
      ),
    )
  }
  // The work of a terminal, made at its first change.
  const ensure = (at: Placed): Work => ownedBy(at.terminalId) ?? make(at)
  return {
    state,
    made,
    // The demo's works are always current.
    watch: () => () => {},
    look: (root) => change(root, looked),
    show: (root, terminalId) => {
      const work = find(root)
      // The terminal the panel names: the owner's, or the selected one's where the owner is closed.
      const on = terminalId ?? work?.terminalId ?? undefined
      return work && show && on !== undefined ? show(work, on) : Promise.resolve(null)
    },
    // Origin is fetched at once in the demo: its works' fetch time moves to now.
    fetch: async (projectId) => {
      const at = now()
      state.update((current) => ({
        ...current,
        works: current.works.map((work) =>
          work.projectId === projectId ? { ...work, fetchedAt: at } : work,
        ),
      }))
    },
    preview: async (projectId, path): Promise<WorkPreview> =>
      preview
        ? preview.read(state.getSnapshot().works, projectId, path)
        : { main: null, works: [], renames: [] },
    touchFile,
    previewScenario: (which, on) => {
      if (!preview) return
      const at = now()
      preview.scenario(which, on, at)
      // Crow's files, and Moth's, which only come with the rename and stay after it.
      const crow: [string, Partial<WorkFile>, "added" | "deleted"][] =
        which === "added"
          ? [[addedPath, { status: "added" }, "added"]]
          : [
              [renamedTo, { status: "renamed", from: renamedPath }, "added"],
              [renamedPath, { status: "deleted" }, "deleted"],
            ]
      // Moth edits the old file, which Crow then renames away: deleted shows over modified.
      if (on && which === "rename") {
        touchFile(preview.mothTerminal, renamedPath, at)
        mark?.(demoHandle(1), renamedPath, "modified")
      }
      const handle = demoHandle(4)
      for (const [path, extra, kind] of crow) {
        // The old path is Moth's file too: Crow's rename is no file of its own in the work.
        const listed = which === "rename" && path === renamedPath ? undefined : extra
        if (on) {
          if (listed) touchFile(preview.crowTerminal, path, at, listed)
          mark?.(handle, path, kind)
        } else {
          const own = ownedBy(preview.crowTerminal)
          if (own && listed)
            change(own.root, (work) =>
              summed(
                work,
                work.files.filter((file) => file.path !== path),
              ),
            )
          mark?.(handle, path, undefined)
        }
      }
    },
    previewOwl: (kind) => {
      if (!preview) return
      const at = now()
      preview.owl(kind, at)
      if (kind) touchFile(preview.owlTerminal, previewPath, at)
      else {
        // Back as it was: the work no longer lists the file.
        const own = ownedBy(preview.owlTerminal)
        if (own)
          change(own.root, (work) =>
            summed(
              work,
              work.files.filter((file) => file.path !== previewPath),
            ),
          )
      }
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
      const commits = unmerged.get(root) ?? 0
      const files = work.files.length
      const holds = [
        ...(files > 0 || work.truncated
          ? [`${files} changed file${files === 1 ? "" : "s"}${work.truncated ? " or more" : ""}`]
          : []),
        ...(commits > 0
          ? [`${commits} commit${commits === 1 ? "" : "s"} the main branch doesn't have`]
          : []),
      ].join(" and ")
      // A safe one closes without asking, as the runner's does: what it holds lives elsewhere too.
      const safe = !force && work.safe === true
      if (holds !== "" && !force && !safe) return { closed: false, holds }
      unmerged.delete(root)
      state.update((current) => drop(current, root))
      return {
        closed: true,
        ...(holds !== "" &&
          !safe && { kept: `refs/novadeck/kept/${slug(work.branch ?? "detached")}-work` }),
        // The branch stays where its commits aren't in main: a closed pull request's.
        branchDeleted: holds === "" || (safe && files === 0),
      }
    },
    gain: (at, lines = turnLines) => {
      const { root } = ensure(at)
      change(root, (work) => gained(work, lines))
    },
    openBranch: (at, branch) => {
      if (!ownedBy(at.terminalId)) make(at, slug(branch), branch)
    },
    setFiles: (terminalId, plans, at) => {
      const own = ownedBy(terminalId)
      if (!own) return
      change(own.root, (work) => ({
        ...summed(
          work,
          plans.map((plan) => fileOf(plan, at)),
        ),
        uncommitted: plans.length,
      }))
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
    merge: (root) => {
      unmerged.delete(root)
      state.update((current) => ({
        ...current,
        works: current.works.map((work) =>
          work.root === root
            ? standing(merged(work))
            : {
                ...work,
                conflicts: work.conflicts.filter(
                  (conflict) => conflict.with === "main" || conflict.root !== root,
                ),
              },
        ),
      }))
    },
    openClean: (at) => {
      const { root } = ensure(at)
      unmerged.delete(root)
      change(root, emptied)
    },
    makeAnother: (at) => {
      extras += 1
      make({ ...at, root: `${at.root}-${extras + 1}` }, `${slug(at.terminalId)}-${extras + 1}`)
    },
    ownerClosed: (root) =>
      change(root, (work) => ({
        ...work,
        terminalId: `closed-${slug(root)}`,
        working: false,
      })),
    commitsMainLacks: (at, count) => {
      const { root } = ensure(at)
      // Not read as merged, so closing it asks: a merged one with nothing uncommitted is safe.
      change(root, (work) => ({ ...emptied(work), unpushed: count }))
      unmerged.set(root, count)
    },
    setPullRequest: (root, pullState) =>
      change(root, ({ pullRequest, ...work }) => ({
        ...work,
        ...(pullState && {
          pullRequest: demoPullRequest(
            pullRequest?.number ?? 812,
            pullState,
            pullRequest?.title,
            pullRequest?.ci,
            pullRequest?.review,
          ),
        }),
      })),
    setCi: (root, ci) =>
      change(root, ({ pullRequest, ...work }) => ({
        ...work,
        pullRequest: demoPullRequest(
          pullRequest?.number ?? 812,
          pullRequest?.state === "draft" ? "draft" : "open",
          pullRequest?.title,
          ci,
          pullRequest?.review,
        ),
      })),
    setReview: (root, review) =>
      change(root, ({ pullRequest, ...work }) => ({
        ...work,
        pullRequest: demoPullRequest(
          pullRequest?.number ?? 812,
          pullRequest?.state === "draft" ? "draft" : "open",
          pullRequest?.title,
          pullRequest?.ci,
          review,
        ),
      })),
    setUncommitted: (at, count) => {
      const { root } = ensure(at)
      change(root, (work) => ({ ...work, uncommitted: count }))
    },
    setHome: (at, home) => {
      const { root } = ensure(at)
      change(root, (work) => ({ ...work, home }))
    },
    setUnpushed: (at, count) => {
      const { root } = ensure(at)
      change(root, (work) => ({ ...work, unpushed: count }))
    },
    fetchedAgo: (at, minutes) => {
      const { root } = ensure(at)
      // A fetched main is the remote's, as the runner measures it once origin was fetched.
      change(root, (work) => ({
        ...work,
        base: "origin/main",
        fetchedAt: now() - minutes * minute,
      }))
    },
    orphan: (root) => change(root, (work) => ({ ...work, terminalId: null, working: false })),
    setWorking: (terminalId, working) => {
      const own = ownedBy(terminalId)
      if (own && own.working !== working) change(own.root, (work) => ({ ...work, working }))
    },
    refuseNextClose: () => {
      refuse = true
    },
    unreported: (ms) => {
      const works = held?.works ?? state.getSnapshot().works
      clearTimeout(held?.timer)
      state.update(() => ({ works: [], synced: false, reported: false }))
      const timer = setTimeout(() => {
        held = undefined
        state.update(() => ({ works, synced: true, reported: true }))
      }, ms)
      held = { works, timer }
    },
    remove: (root) => {
      unmerged.delete(root)
      state.update((current) => drop(current, root))
    },
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

// A backend with the demo's works. A demo agent that starts a turn gains lines in the first
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
  const preview = createDemoPreview(Date.now())
  const files = isDemoFiles(backend.files) ? backend.files : undefined
  const works = createDemoWorks(worksFromPlans(backend.seed, plans, Date.now()), {
    preview,
    ...(files && { mark: files.mark }),
    ...(show && {
      show: (work: Work, terminalId: string) => show(work, terminalId, latest),
    }),
  })
  // A write by an agent to the previewed file grows its change there and moves its time on, as a
  // runner's works do at each new blob; the files' `touched` says who wrote.
  if (backend.files) {
    const { state } = backend.files
    let before = state.getSnapshot().projects["storefront"]?.changes[previewPath]?.touched ?? {}
    state.subscribe(() => {
      const touched =
        state.getSnapshot().projects["storefront"]?.changes[previewPath]?.touched ?? {}
      for (const [handle, at] of Object.entries(touched)) {
        const terminalId = terminalOfHandle(handle)
        if (terminalId === undefined || at <= (before[handle] ?? Number.NEGATIVE_INFINITY)) continue
        preview.wrote(terminalId, at)
        works.touchFile(terminalId, previewPath, at)
      }
      before = touched
    })
  }
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
