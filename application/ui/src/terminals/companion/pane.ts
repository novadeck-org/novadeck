import type {
  ArtifactRef,
  CompanionKey,
  CompanionSnapshot,
  PlanSnapshot,
} from "../../model/companion"
import type { MovableItem } from "../../model/companion-items"
import { docOf, ordered, type PlanDoc } from "./plan-doc"

// A terminal's companion pane: its plans, what its agent showed, and its messages, each
// an item with a key, and which of them the pane has open. The pane's own items line its
// taskbar in `order`; see ./bar.ts for how the bar is drawn from them.

// Item keys, one string each, as the pane's tab, order and closed lists hold them: a plan
// by its ref, what was shown by its id, and the messages. An item another terminal placed
// on this one's bar has a key of its own here, naming where it's from.
export const planTab = (ref: string): string => `plan:${ref}`

export const planRefOf = (key: string): string | null =>
  key.startsWith("plan:") ? key.slice("plan:".length) : null

export const mailTab = "mail:"

export const itemKey = (item: MovableItem): string =>
  item.kind === "plan" ? planTab(item.ref) : item.id

// The item a key names, unless it's the messages, which never move.
export const movableOf = (key: string): MovableItem | null => {
  if (key === mailTab || isPlaced(key)) return null
  const ref = planRefOf(key)
  return ref === null ? { kind: "artifact", id: key } : { kind: "plan", ref }
}

export const placedKey = (from: string, item: MovableItem): string =>
  `placed:${from}#${itemKey(item)}`

export const isPlaced = (key: string): boolean => key.startsWith("placed:")

// An artifact as the pane holds it: new until the user looks at it.
export type Shown = ArtifactRef & { readonly fresh: boolean; readonly at: string }

export type Pane = {
  readonly key: CompanionKey
  // The root plan first, then subagents' plans.
  readonly plans: readonly PlanDoc[]
  // What the agent showed, in the order it came.
  readonly artifacts: readonly Shown[]
  readonly open: boolean
  readonly tab: string
  // Where the pane goes when what it showed goes: the terminal's main plan.
  readonly home: string
  // The taskbar's items by key, in the order they first came or the person since dragged
  // them into, items placed here from other terminals among them.
  readonly order: readonly string[]
  // Plans and the messages the person closed from the taskbar, which the pane keeps
  // until they reopen. What the agent showed goes when closed, and comes back when shown
  // again.
  readonly closed: readonly string[]
}

const homeOf = (plans: readonly PlanDoc[]): string => (plans[0] ? planTab(plans[0].ref) : "")

// A terminal's pane as its backend first reports it: what came before, seen, in the
// order the backend tells it.
export const paneOf = ({ key, plans, shown }: CompanionSnapshot): Pane => {
  const docs = ordered(plans.map(docOf))
  return {
    key,
    plans: docs,
    artifacts: shown.map((artifact): Shown => ({ ...artifact, fresh: false, at: "1 min ago" })),
    open: false,
    tab: homeOf(docs),
    home: homeOf(docs),
    order: [...docs.map((plan) => planTab(plan.ref)), ...shown.map((artifact) => artifact.id)],
    closed: [],
  }
}

export const emptyPane = (key: CompanionKey): Pane => paneOf({ key, plans: [], shown: [] })

// Whether the pane holds anything the agent put there: a plan, or something it showed.
export const hasContent = (pane: Pane): boolean =>
  pane.plans.length > 0 || pane.artifacts.length > 0

// Something came to the taskbar: it joins the end of its order, unless it has a place.
export const arrived = (pane: Pane, key: string): Pane =>
  pane.order.includes(key) ? pane : { ...pane, order: [...pane.order, key] }

// Something came to the taskbar again, as an item placed here once more: last, as
// anything new is.
export const arrivedAgain = (pane: Pane, key: string): Pane =>
  pane.order.at(-1) === key
    ? pane
    : { ...pane, order: [...pane.order.filter((each) => each !== key), key] }

export const withPlan = (pane: Pane, ref: string, change: (plan: PlanDoc) => PlanDoc): Pane => {
  let changed = false
  const plans = pane.plans.map((plan) => {
    if (plan.ref !== ref) return plan
    const next = change(plan)
    changed ||= next !== plan
    return next
  })
  return changed ? { ...pane, plans } : pane
}

// Whether the pane holds the item a key names, apart from the messages and what's
// placed here, which only the bar knows of.
const holds = (pane: Pane, key: string): boolean => {
  const ref = planRefOf(key)
  return ref === null
    ? pane.artifacts.some((shown) => shown.id === key)
    : pane.plans.some((plan) => plan.ref === ref)
}

// What the pane shows: its tab, while that's on the bar, or else its home, or else the
// first thing shown that may show unpicked, never a held one. Nothing, when that's "".
export const shownTab = (pane: Pane, onBar: (key: string) => boolean): string =>
  onBar(pane.tab)
    ? pane.tab
    : onBar(pane.home)
      ? pane.home
      : (pane.artifacts.find((shown) => !shown.held && onBar(shown.id))?.id ?? "")

// The plan the pane is reading, as far as the pane alone can tell: none while the
// messages or something placed here is chosen.
const readingPlan = (pane: Pane): string | null =>
  pane.open ? planRefOf(shownTab(pane, (key) => key === pane.tab || holds(pane, key))) : null

// Reading a plan's tab counts as reading its latest rewrite.
const markRead = (pane: Pane): Pane => {
  const ref = readingPlan(pane)
  return ref === null ? pane : seen(pane, planTab(ref))
}

// Whether the pane is reading the plan, which takes the agent's rewrite as seen.
export const reading = (pane: Pane, ref: string): boolean => readingPlan(pane) === ref

// The person looked at the item, wherever it showed: a plan's latest rewrite is read,
// something shown is no longer new.
export const seen = (pane: Pane, key: string): Pane => {
  const ref = planRefOf(key)
  if (ref !== null)
    return withPlan(pane, ref, (plan) =>
      plan.seen === plan.writes ? plan : { ...plan, seen: plan.writes },
    )
  return pane.artifacts.some((shown) => shown.id === key && shown.fresh)
    ? {
        ...pane,
        artifacts: pane.artifacts.map((shown) =>
          shown.id === key ? { ...shown, fresh: false } : shown,
        ),
      }
    : pane
}

// Looking at a tab makes what's there old news.
export const openTab = (pane: Pane, tab: string): Pane =>
  markRead(seen({ ...pane, tab, open: true }, tab))

// Opening the pane without choosing a tab goes to what's new, if anything is, but never
// to something held, which waits to be picked.
export const openPane = (pane: Pane): Pane => {
  const fresh = pane.artifacts.findLast((shown) => shown.fresh && !shown.held)
  return fresh ? openTab(pane, fresh.id) : markRead({ ...pane, open: true })
}

export const closePane = (pane: Pane): Pane => (pane.open ? { ...pane, open: false } : pane)

// An item leaves the bar, undocked, placed elsewhere or sent home: a pane opened to it
// hides, so it neither shows something else in its place nor opens on its own when the
// item comes back.
export const hideShowing = (pane: Pane, key: string): Pane =>
  pane.tab === key ? closePane(pane) : pane

// The agent put something in front of the user, or showed it again with new content.
// It waits in the taskbar unless the user asked for it, and then it opens. Something
// shown `before` this session is listed and nothing more.
export const show = (pane: Pane, artifact: ArtifactRef, asked: boolean, before = false): Pane => {
  const shown: Shown = { ...artifact, fresh: !asked && !before, at: "just now" }
  const known = pane.artifacts.some((existing) => existing.id === artifact.id)
  const listed = {
    ...arrived(pane, artifact.id),
    artifacts: known
      ? pane.artifacts.map((existing) => (existing.id === artifact.id ? shown : existing))
      : [...pane.artifacts, shown],
  }
  return markRead(asked && !before ? { ...listed, tab: artifact.id, open: true } : listed)
}

// A plan appeared: it joins the bar, back on it if the person had closed it.
export const planAdded = (pane: Pane, plan: PlanSnapshot): Pane => {
  const plans = ordered([...pane.plans, docOf(plan)])
  const key = planTab(plan.ref)
  return {
    ...arrived(reopen(pane, key), key),
    plans,
    home: homeOf(plans),
    tab: pane.tab || homeOf(plans),
  }
}

// The agent no longer keeps the plan.
export const planRemoved = (pane: Pane, ref: string): Pane => {
  const plans = pane.plans.filter((plan) => plan.ref !== ref)
  return { ...pane, plans, home: homeOf(plans) }
}

export const toggleChanges = (pane: Pane, ref: string): Pane =>
  withPlan(pane, ref, (plan) => ({ ...plan, showChanges: !plan.showChanges }))

// The person closed it from the taskbar. Something shown goes, and comes back last when
// shown again. A plan or the messages leave the bar until they reopen. Closing what the
// pane shows hides the pane, so nothing takes its place, and nothing opens when it
// comes back.
// TODO: tell the backend, so the agent can reopen what was closed when asked.
export const close = (pane: Pane, key: string): Pane => {
  const hidden = pane.tab === key ? { ...pane, open: false, tab: pane.home } : pane
  const off = { ...hidden, order: hidden.order.filter((each) => each !== key) }
  if (pane.artifacts.some((shown) => shown.id === key))
    return { ...off, artifacts: off.artifacts.filter((shown) => shown.id !== key) }
  return pane.closed.includes(key) ? off : { ...off, closed: [...off.closed, key] }
}

// What was closed is back on the taskbar, last, as anything new is: a plan the agent
// rewrote, the messages when one comes, or what the agent was asked to reopen.
export const reopen = (pane: Pane, key: string): Pane =>
  pane.closed.includes(key)
    ? arrived({ ...pane, closed: pane.closed.filter((each) => each !== key) }, key)
    : pane

// A pane left with nothing to show closes, so nothing reopens it on its own later. The
// messages still show, and so does an item placed here.
export const settle = (pane: Pane): Pane =>
  pane.open && pane.tab !== mailTab && !isPlaced(pane.tab) && !hasContent(pane)
    ? { ...pane, open: false }
    : pane
