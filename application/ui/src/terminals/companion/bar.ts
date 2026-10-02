import { companionKeyId, type ArtifactKind, type CompanionKey } from "../../model/companion"
import type { Placement } from "../../model/companion-items"
import type { WorkspaceTarget } from "../../model/types"
import { itemKey, mailTab, placedKey, planTab, type Pane, type Shown } from "./pane"
import { unread, type PlanDoc } from "./plan-doc"
import type { PaneMap } from "./state"

// A terminal's taskbar, drawn from its pane: its plans, what its agent showed and its
// messages, less what's away (undocked into a window, placed on another terminal's bar,
// or closed), and with what other terminals placed on it. Items of a kind stack under one
// icon once there are several, as a taskbar groups an app's windows; the messages never
// stack. Everything keeps the order it came in, or the person dragged it into.

export type MemberContent =
  | { readonly kind: "plan"; readonly plan: PlanDoc }
  | { readonly kind: "artifact"; readonly artifact: Shown }
  | { readonly kind: "messages" }

// One item on a terminal's taskbar. `id` is its key on this bar and `key` its key in its
// own terminal's pane, `source`, which it loads and saves through; they differ for an item
// placed here from another terminal.
export type BarMember = {
  readonly id: string
  readonly key: string
  readonly source: CompanionKey
  readonly placed: boolean
  readonly content: MemberContent
}

export type StackKind = "plan" | ArtifactKind

// An icon on the bar: one item, or a stack of a kind. `key` stays the same as it moves.
export type BarSlot = {
  readonly key: string
  readonly stack: StackKind | null
  readonly members: readonly BarMember[]
}

const stackOf = (member: BarMember): StackKind | null =>
  member.content.kind === "plan"
    ? "plan"
    : member.content.kind === "artifact"
      ? member.content.artifact.kind
      : null

// Whether it waits for the person to look: a plan the agent rewrote since they read it,
// or something shown they haven't opened.
export const isNew = (member: BarMember): boolean =>
  member.content.kind === "plan"
    ? unread(member.content.plan)
    : member.content.kind === "artifact" && member.content.artifact.fresh

// Something that may hold secrets, which opens only when picked.
export const isHeld = (member: BarMember): boolean =>
  member.content.kind === "artifact" && Boolean(member.content.artifact.held)

// The terminal's own items on its bar: all its pane holds but what's closed or `away`,
// by their keys, and its messages while it has them.
export const ownMembers = (
  pane: Pane,
  away: ReadonlySet<string>,
  messages: boolean,
): readonly BarMember[] => {
  const here = (key: string): boolean => !away.has(key) && !pane.closed.includes(key)
  const member = (key: string, content: MemberContent): BarMember => ({
    id: key,
    key,
    source: pane.key,
    placed: false,
    content,
  })
  return [
    ...pane.plans
      .filter((plan) => here(planTab(plan.ref)))
      .map((plan) => member(planTab(plan.ref), { kind: "plan", plan })),
    ...pane.artifacts
      .filter((artifact) => here(artifact.id))
      .map((artifact) => member(artifact.id, { kind: "artifact", artifact })),
    ...(messages && here(mailTab) ? [member(mailTab, { kind: "messages" })] : []),
  ]
}

// Other terminals' items placed on terminal `to`'s bar, as their own panes hold them now.
// A placement whose item its terminal no longer has shows nothing.
export const placedMembers = (
  placements: readonly Placement[],
  to: string,
  session: WorkspaceTarget,
  panes: PaneMap,
): readonly BarMember[] =>
  placements.flatMap((placement): BarMember[] => {
    if (placement.to !== to) return []
    const source = { ...session, terminalId: placement.from }
    const pane = panes[companionKeyId(source)]
    const key = itemKey(placement.item)
    const base = { id: placedKey(placement.from, placement.item), key, source, placed: true }
    if (placement.item.kind === "plan") {
      const { ref } = placement.item
      const plan = pane?.plans.find((each) => each.ref === ref)
      return plan ? [{ ...base, content: { kind: "plan", plan } }] : []
    }
    const { id } = placement.item
    const artifact = pane?.artifacts.find((each) => each.id === id)
    return artifact ? [{ ...base, content: { kind: "artifact", artifact } }] : []
  })

// Everything on terminal `pane`'s bar, its own items and those placed on it, and its own
// keys that are away: undocked into windows of their own, or placed on other bars.
export const barMembers = ({
  pane,
  undocked,
  placements,
  messages,
  panes,
}: {
  readonly pane: Pane
  readonly undocked: readonly string[]
  readonly placements: readonly Placement[]
  readonly messages: boolean
  // The panes of the terminals whose items are placed here.
  readonly panes: PaneMap
}): { readonly members: readonly BarMember[]; readonly away: ReadonlySet<string> } => {
  const terminal = pane.key.terminalId
  const away = new Set([
    ...undocked,
    ...placements
      .filter((placement) => placement.from === terminal)
      .map((placement) => itemKey(placement.item)),
  ])
  const { projectId, workspaceSessionId } = pane.key
  return {
    members: [
      ...ownMembers(pane, away, messages),
      ...placedMembers(placements, terminal, { projectId, workspaceSessionId }, panes),
    ],
    away,
  }
}

// The bar's icons in order: each item where it came, a stack where its first item came,
// and anything the order doesn't know yet after, as given.
export const composeBar = (pane: Pane, members: readonly BarMember[]): readonly BarSlot[] => {
  const rank = (member: BarMember): number => {
    const place = pane.order.indexOf(member.id)
    return place < 0 ? pane.order.length + members.indexOf(member) : place
  }
  const sorted = members.toSorted((a, b) => rank(a) - rank(b))
  const stacks = new Map<StackKind, BarMember[]>()
  for (const member of sorted) {
    const kind = stackOf(member)
    if (kind) stacks.set(kind, [...(stacks.get(kind) ?? []), member])
  }
  return sorted.flatMap((member): BarSlot[] => {
    const kind = stackOf(member)
    const stack = kind ? stacks.get(kind)! : [member]
    if (stack.length < 2) return [{ key: member.id, stack: null, members: [member] }]
    return stack[0] === member ? [{ key: `stack:${kind}`, stack: kind, members: stack }] : []
  })
}

// The keys of everything on the bar, what the pane may show.
export const onBar = (slots: readonly BarSlot[]): ReadonlySet<string> =>
  new Set(slots.flatMap((slot) => slot.members.map((member) => member.id)))

// The bar's slot at `from` moved to `to`: the pane's order with its items moved along, a
// stack's together and in its own order. What isn't on the bar, as what's undocked,
// keeps its place.
export const moveSlot = (pane: Pane, slots: readonly BarSlot[], from: number, to: number): Pane => {
  const moved = [...slots]
  const [slot] = moved.splice(from, 1)
  if (!slot) return pane
  moved.splice(to, 0, slot)
  const placed = moved.flatMap((each) => each.members.map((member) => member.id))
  const moving = new Set(placed)
  const all = [...pane.order, ...placed.filter((id) => !pane.order.includes(id))]
  let next = 0
  return { ...pane, order: all.map((id) => (moving.has(id) ? placed[next++]! : id)) }
}

// Which of a stack a click opens. Of plans: the first the agent rewrote since it was read,
// else the one open, else the first, the root plan where it's among them. Of anything
// else: what's new, else what's open, else the latest, a held one only when the stack
// holds nothing else, as the click then picks it.
export const pick = (slot: BarSlot, showing: string): BarMember =>
  slot.stack === "plan"
    ? (slot.members.find(isNew) ??
      slot.members.find((member) => member.id === showing) ??
      slot.members[0]!)
    : (slot.members.findLast((member) => isNew(member) && !isHeld(member)) ??
      slot.members.find((member) => member.id === showing) ??
      slot.members.findLast((member) => !isHeld(member)) ??
      slot.members.at(-1)!)
