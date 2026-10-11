// How the person arranged the projects in the switcher: their order, by id, and the ones
// they pinned, which come first and show in the header too. At most `pinLimit` are
// pinned. Projects it doesn't name, as one just added, follow in the runner's order; ids
// of projects since removed are dropped on the next change.
export type ProjectArrangement = {
  readonly order: readonly string[]
  readonly pinned: readonly string[]
}

export const pinLimit = 9

export const noArrangement: ProjectArrangement = { order: [], pinned: [] }

// The projects as the switcher lists them: the pinned ones, then the rest, each in the
// person's order.
export const arrangeProjects = <P extends { readonly id: string }>(
  projects: readonly P[],
  { order, pinned }: ProjectArrangement,
): { readonly pinned: P[]; readonly rest: P[] } => {
  const rank = new Map(order.map((id, index) => [id, index]))
  const sorted = projects
    .map((project, index) => ({ project, index }))
    .toSorted(
      (a, b) =>
        (rank.get(a.project.id) ?? order.length + a.index) -
        (rank.get(b.project.id) ?? order.length + b.index),
    )
    .map(({ project }) => project)
  const pins = new Set(pinned)
  const kept = sorted.filter((project) => pins.has(project.id)).slice(0, pinLimit)
  return {
    pinned: kept,
    rest: sorted.filter((project) => !kept.includes(project)),
  }
}

// The arrangement of what the switcher lists, pinned first: what `order` lists, the first
// `pinnedCount` of them pinned.
const arrangement = (order: readonly string[], pinnedCount: number): ProjectArrangement => ({
  order,
  pinned: order.slice(0, pinnedCount),
})

// Moves a project to `index` in the switcher's list, pinned ones first. Dropped among the
// pinned ones it's pinned, among the rest it isn't; on the edge between them it keeps
// what it was. A move that would pin one more than `pinLimit` leaves things as they are.
export const moveProject = (
  projects: readonly { readonly id: string }[],
  current: ProjectArrangement,
  id: string,
  index: number,
): ProjectArrangement => {
  const { pinned, rest } = arrangeProjects(projects, current)
  const listed = [...pinned, ...rest].map((project) => project.id)
  const from = listed.indexOf(id)
  if (from < 0) return current
  const wasPinned = from < pinned.length
  const others = listed.filter((each) => each !== id)
  const othersPinned = pinned.length - (wasPinned ? 1 : 0)
  const to = Math.max(0, Math.min(index, others.length))
  const pins = to < othersPinned || (to === othersPinned && wasPinned)
  if (pins && !wasPinned && othersPinned >= pinLimit) return current
  if (to === from) return current
  const order = [...others.slice(0, to), id, ...others.slice(to)]
  return arrangement(order, othersPinned + (pins ? 1 : 0))
}

// Pins a project at the end of the pinned ones, or unpins it to the top of the rest. A
// pin beyond `pinLimit` leaves things as they are.
export const togglePin = (
  projects: readonly { readonly id: string }[],
  current: ProjectArrangement,
  id: string,
): ProjectArrangement => {
  const { pinned, rest } = arrangeProjects(projects, current)
  const pinnedIds = pinned.map((project) => project.id)
  const restIds = rest.map((project) => project.id)
  if (pinnedIds.includes(id)) {
    const kept = pinnedIds.filter((each) => each !== id)
    return arrangement([...kept, id, ...restIds], kept.length)
  }
  if (!restIds.includes(id) || pinnedIds.length >= pinLimit) return current
  return arrangement(
    [...pinnedIds, id, ...restIds.filter((each) => each !== id)],
    pinnedIds.length + 1,
  )
}

// Pins a project at `index` among the pinned ones, as a drop on the pins bar does: one
// already pinned moves there, one that isn't is pinned there unless `pinLimit` are.
export const pinAt = (
  projects: readonly { readonly id: string }[],
  current: ProjectArrangement,
  id: string,
  index: number,
): ProjectArrangement => {
  const { pinned, rest } = arrangeProjects(projects, current)
  const pinnedIds = pinned.map((project) => project.id)
  const restIds = rest.map((project) => project.id)
  if (pinnedIds.includes(id))
    return moveProject(projects, current, id, Math.min(index, pinnedIds.length - 1))
  if (!restIds.includes(id) || pinnedIds.length >= pinLimit) return current
  const to = Math.max(0, Math.min(index, pinnedIds.length))
  return arrangement(
    [
      ...pinnedIds.slice(0, to),
      id,
      ...pinnedIds.slice(to),
      ...restIds.filter((each) => each !== id),
    ],
    pinnedIds.length + 1,
  )
}

// Steps a project one place up or down the switcher's list, as Alt and the arrows do:
// within its group it moves a place; across the rule it pins or unpins in place rather
// than skipping a row, so Alt+Down on the last pinned one unpins it and Alt+Up on the
// first of the rest pins it, which a full set of pins refuses. It stops at the list's ends.
export const stepProject = (
  projects: readonly { readonly id: string }[],
  current: ProjectArrangement,
  id: string,
  by: -1 | 1,
): ProjectArrangement => {
  const { pinned, rest } = arrangeProjects(projects, current)
  const listed = [...pinned, ...rest].map((project) => project.id)
  const index = listed.indexOf(id)
  if (index < 0) return current
  const crossing = by === 1 ? index === pinned.length - 1 : index === pinned.length
  return crossing
    ? togglePin(projects, current, id)
    : moveProject(projects, current, id, index + by)
}
