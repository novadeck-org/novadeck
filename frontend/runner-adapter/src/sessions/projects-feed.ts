import type { BackendAction } from "@novadeck/core/port"
import type { Workspace, WorkspaceProject } from "@novadeck/core/types"
import { hasCode, type Runner } from "@novadeck/runner-client"

import { consume, reportCaught } from "../streams"

/** How the person arranged the projects: their ids in order, and the pinned ones. */
export type ProjectArrangement = {
  readonly order: readonly string[]
  readonly pinned: readonly string[]
}

/**
 * Follows the projects as the runner holds them (`projects.watch`), for what another client
 * did to them: a project it made is read and joins this client's list, one it removed goes,
 * one it renamed takes the name, and how the projects are arranged is told (`arranged`) for
 * the page to take; a project's sessions as it arranged them are told too (`sessionsArranged`).
 * All of it is laid in here and never sent back. A runner from before
 * revision 5 has no such feed: nothing is followed.
 */
export const followProjects = (options: {
  readonly runner: Pick<Runner, "projects" | "supports">
  readonly latest: () => Workspace | undefined
  readonly dispatch: (actions: readonly BackendAction[]) => void
  readonly now: () => number
  // Reads a project from the runner, as a window taking a project on does; undefined for
  // one gone meanwhile.
  readonly read: (projectId: string) => Promise<WorkspaceProject | undefined>
  // Whether this client removed the project itself: the runner's list catches up on its own.
  readonly removedHere: (projectId: string) => boolean
  // While true, a project the runner lets go of may be this client's own doing, as a tour it
  // starts removes the tours before: held until `released`.
  readonly holding: () => boolean
  readonly arranged: (arrangement: ProjectArrangement) => void
  readonly sessionsArranged: (projectId: string, order: readonly string[]) => void
  // The projects the runner listed as this client loaded.
  readonly listed: readonly string[]
}): { readonly stop: () => void; readonly released: () => void } => {
  const { runner } = options
  const quiet = { stop: () => {}, released: () => {} }
  if (typeof runner.supports !== "function" || !runner.supports("projects.watch")) return quiet
  // Every project the runner has listed: only one of these can be removed elsewhere, as one
  // this client made may not have reached the runner yet. One the workspace keeps (its last)
  // is told again with each list.
  const ever = new Set(options.listed)
  let there = new Set(options.listed)
  const held = new Set<string>()
  const reading = new Set<string>()
  const gone = (projectIds: readonly string[]): void => {
    const now = options.now()
    if (projectIds.length)
      options.dispatch(
        projectIds.map((projectId) => ({ type: "project/gone", projectId, now }) as const),
      )
  }
  const changes = runner.projects.watch()
  void consume(changes, (change) => {
    if (change.type === "arranged") {
      options.sessionsArranged(change.projectId, change.order)
      return
    }
    const { projects: listed } = change
    there = new Set(listed.map(({ id }) => id))
    for (const { id } of listed) ever.add(id)
    const here = options.latest()?.projects ?? []
    const renamed: BackendAction[] = []
    for (const project of listed) {
      const known = here.find(({ id }) => id === project.id)
      if (known && known.name !== project.name)
        renamed.push({ type: "project/renamed", projectId: project.id, name: project.name })
    }
    if (renamed.length) options.dispatch(renamed)
    const left = here
      .map(({ id }) => id)
      .filter((id) => ever.has(id) && !there.has(id) && !options.removedHere(id))
    if (options.holding()) for (const id of left) held.add(id)
    else gone(left)
    for (const project of listed) {
      const known = here.some(({ id }) => id === project.id)
      if (known || reading.has(project.id) || options.removedHere(project.id)) continue
      reading.add(project.id)
      void options.read(project.id).then(
        (made) => {
          reading.delete(project.id)
          // Unless it went meanwhile, or this client has it by now.
          if (
            made &&
            there.has(made.id) &&
            !options.latest()?.projects.some(({ id }) => id === made.id)
          )
            options.dispatch([{ type: "project/sync", project: made }])
        },
        (error: unknown) => {
          reading.delete(project.id)
          // Read again as the feed opens again with the link; one gone meanwhile is gone.
          if (!hasCode(error, "DISCONNECTED", "CLOSING", "NOT_FOUND")) reportCaught(error)
        },
      )
    }
    options.arranged({
      order: listed.map(({ id }) => id),
      pinned: listed.filter(({ pinned }) => pinned).map(({ id }) => id),
    })
  })
  return {
    stop: () => {
      void changes.return?.()?.catch(() => {})
    },
    // What went while held, but for what this client removed itself, went elsewhere.
    released: () => {
      if (options.holding()) return
      const here = new Set(options.latest()?.projects.map(({ id }) => id) ?? [])
      const left = [...held].filter((id) => here.has(id) && !options.removedHere(id))
      held.clear()
      gone(left)
    },
  }
}
