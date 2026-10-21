import type { SourceProject } from "@novadeck/core/source"

// The Source panel's agents strip, apart from how it draws: which agents have work here, how
// the strip groups them, what the person keeps lit and what is lit as a result.

// Where a lead and the terminals it leads sit, as handles: the lead first.
export type Squad = readonly string[]

// A chip of its own, or a squad's chips in one track (two or more, the lead first).
export type StripItem =
  | { readonly kind: "solo"; readonly handle: string }
  | { readonly kind: "squad"; readonly members: readonly string[] }

// The agents with work in the project: a change touched by them, or a file they are writing.
export const workingAgents = (project: SourceProject): ReadonlySet<string> => {
  const agents = new Set<string>()
  for (const change of Object.values(project.changes))
    for (const handle of Object.keys(change.touched)) agents.add(handle)
  for (const handle of Object.keys(project.writing)) agents.add(handle)
  return agents
}

// The strip's items. Agents follow the session's roster order (`roster`, handles); those with no
// terminal in it come after, alphabetically. A squad sits where its first member does, holding
// only the members with work, and a team left with fewer than two is no squad: they are solo
// chips. An agent belongs to the first of `squads` that names it.
export const stripItems = (
  project: SourceProject,
  roster: readonly string[],
  squads: readonly Squad[],
): readonly StripItem[] => {
  const working = workingAgents(project)
  const ordered = [
    ...roster.filter((handle, index) => working.has(handle) && roster.indexOf(handle) === index),
    ...[...working].filter((handle) => !roster.includes(handle)).toSorted(),
  ]
  const taken = new Set<string>()
  const squadOf = new Map<string, readonly string[]>()
  for (const squad of squads) {
    const members = [...new Set(squad)].filter(
      (handle) => working.has(handle) && !taken.has(handle),
    )
    if (members.length < 2) continue
    for (const handle of members) {
      taken.add(handle)
      squadOf.set(handle, members)
    }
  }
  const items: StripItem[] = []
  const placed = new Set<string>()
  for (const handle of ordered) {
    if (placed.has(handle)) continue
    const members = squadOf.get(handle)
    if (members) {
      members.forEach((member) => placed.add(member))
      items.push({ kind: "squad", members })
    } else {
      placed.add(handle)
      items.push({ kind: "solo", handle })
    }
  }
  return items
}

// The kept set with this agent in it if it was out, else out.
export const toggleAgent = (kept: ReadonlySet<string>, handle: string): ReadonlySet<string> => {
  const next = new Set(kept)
  if (!next.delete(handle)) next.add(handle)
  return next
}

// A squad as a whole: released when every member is kept, else all kept.
export const toggleSquad = (
  kept: ReadonlySet<string>,
  members: readonly string[],
): ReadonlySet<string> => {
  const next = new Set(kept)
  if (members.every((handle) => kept.has(handle))) members.forEach((handle) => next.delete(handle))
  else members.forEach((handle) => next.add(handle))
  return next
}

// What the person has lit, before any pointing: the kept set if it holds anyone, else the
// selected terminal's agent when it has work in this project, else nobody.
export const litSet = (
  project: SourceProject | undefined,
  kept: ReadonlySet<string>,
  selected: string | undefined,
): ReadonlySet<string> => {
  if (kept.size > 0) return kept
  if (!project || !selected || !workingAgents(project).has(selected)) return noAgents
  return new Set([selected])
}

export const noAgents: ReadonlySet<string> = new Set()

// Whether a row (a file, or a folder with files inside) is dimmed: someone is lit and none of
// them touched it or is writing in it.
export const dimmedBy = (
  node: { readonly touched: Readonly<Record<string, number>>; readonly writing: readonly string[] },
  lit: ReadonlySet<string>,
): boolean =>
  lit.size > 0 &&
  ![...lit].some((handle) => handle in node.touched || node.writing.includes(handle))

// Names for the tree's description: "@moth", "@moth and @crow", "@a, @b and @c".
export const namedAgents = (handles: Iterable<string>): string => {
  const names = [...handles].map((handle) => `@${handle}`)
  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}
