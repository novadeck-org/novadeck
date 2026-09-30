import type { Artifact } from "../../model/companion"

// What a terminal's companion pane holds besides the plan: what its agent showed, in the
// order it came, and which of it is open.

// An artifact as the pane holds it: new until the user looks at it.
export type Shown = Artifact & { readonly fresh: boolean; readonly at: string }

// The pane's first tab is always the plan.
export const planTab = "plan"

export type Companion = {
  readonly open: boolean
  readonly tab: string
  readonly artifacts: readonly Shown[]
}

// The agent put something in front of the user. It waits in the taskbar unless the user
// asked for it, and then it opens.
export const show = <C extends Companion>(companion: C, artifact: Artifact, asked: boolean): C =>
  companion.artifacts.some((shown) => shown.id === artifact.id)
    ? companion
    : {
        ...companion,
        artifacts: [...companion.artifacts, { ...artifact, fresh: !asked, at: "just now" }],
        ...(asked ? { tab: artifact.id, open: true } : {}),
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
  tab: companion.tab === id ? planTab : companion.tab,
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
