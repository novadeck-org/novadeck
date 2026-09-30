import type { ArtifactRef } from "../../model/companion"

// What a terminal's companion pane holds besides its plans: what the agent showed, in
// the order it came, and which tab is open.

// An artifact as the pane holds it: new until the user looks at it.
export type Shown = ArtifactRef & { readonly fresh: boolean; readonly at: string }

// A plan's tab, by its ref, apart from the artifacts' tabs.
export const planTab = (ref: string): string => `plan:${ref}`

export const planRefOf = (tab: string): string | null =>
  tab.startsWith("plan:") ? tab.slice("plan:".length) : null

export type Companion = {
  readonly open: boolean
  readonly tab: string
  // Where the pane goes when what it showed goes: the terminal's main plan.
  readonly home: string
  readonly artifacts: readonly Shown[]
}

// The agent put something in front of the user, or showed it again with new content.
// It waits in the taskbar unless the user asked for it, and then it opens. Something
// already `seen`, shown before this session, is listed and nothing more.
export const show = <C extends Companion>(
  companion: C,
  artifact: ArtifactRef,
  asked: boolean,
  seen = false,
): C => {
  const opens = asked && !seen
  const shown: Shown = { ...artifact, fresh: !asked && !seen, at: "just now" }
  const known = companion.artifacts.some((existing) => existing.id === artifact.id)
  return {
    ...companion,
    artifacts: known
      ? companion.artifacts.map((existing) => (existing.id === artifact.id ? shown : existing))
      : [...companion.artifacts, shown],
    ...(opens ? { tab: artifact.id, open: true } : {}),
  }
}

// Looking at an artifact makes it old news.
export const selectTab = <C extends Companion>(companion: C, tab: string): C => ({
  ...companion,
  tab,
  open: true,
  artifacts: companion.artifacts.map((shown) =>
    shown.id === tab && shown.fresh ? { ...shown, fresh: false } : shown,
  ),
})

// Opening the pane without choosing a tab goes to what's new, if anything is.
export const openCompanion = <C extends Companion>(companion: C): C => {
  const fresh = companion.artifacts.findLast((shown) => shown.fresh)
  return fresh ? selectTab(companion, fresh.id) : { ...companion, open: true }
}

// The user is done with it: it leaves the pane, and the pane falls back to the plan.
export const dismiss = <C extends Companion>(companion: C, id: string): C => ({
  ...companion,
  tab: companion.tab === id ? companion.home : companion.tab,
  artifacts: companion.artifacts.filter((shown) => shown.id !== id),
})

// A taskbar slot: one artifact, or every image, grouped as a taskbar groups an app's
// windows once there are several. Slots keep the order things first arrived in.
export type Slot =
  | { readonly kind: "one"; readonly artifact: Shown }
  | { readonly kind: "images"; readonly artifacts: readonly Shown[] }

export const slotsOf = (artifacts: readonly Shown[]): readonly Slot[] => {
  const images = artifacts.filter((shown) => shown.kind === "image")
  return artifacts.flatMap((artifact): Slot[] => {
    if (artifact.kind !== "image" || images.length < 2) return [{ kind: "one", artifact }]
    return artifact === images[0] ? [{ kind: "images", artifacts: images }] : []
  })
}

// Which of a group a click opens: what's new, else the one already open, else the latest.
export const pickFromGroup = (companion: Companion, group: readonly Shown[]): Shown =>
  group.findLast((shown) => shown.fresh) ??
  group.find((shown) => shown.id === companion.tab) ??
  group.at(-1)!

export const freshCount = (companion: Companion): number =>
  companion.artifacts.filter((shown) => shown.fresh).length
