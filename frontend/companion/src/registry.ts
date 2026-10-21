import type { ArtifactKind } from "@novadeck/core/companion"
import type { LucideIcon } from "lucide-react"

import type { BarMember, BarSlot } from "./bar"
import { changes } from "./panes/changes"
import { file } from "./panes/file"
import { image } from "./panes/image"
import { messages } from "./panes/messages"
import { page } from "./panes/page"
import { plan } from "./panes/plan"
import type { Drawing, PaneKind, Registry } from "./registration"

// Every kind of thing on a terminal's bar, by its registration. A new artifact
// type is one folder in `panes/` and one line here, with its data parts in core; a kind that core adds without one
// fails to compile, since `Registry` maps every `PaneKind`.
export const registry = { image, file, page, changes, plan, messages } satisfies Registry

// The registry's kind for a bar's member.
export const kindOf = (member: BarMember): PaneKind =>
  member.kind === "messages" ? "messages" : member.item.kind

// The registration that draws `member`. A member's kind picks its registration, which takes
// that kind of member: the one place that is cast.
export const registrationOf = (member: BarMember): Drawing =>
  registry[kindOf(member)] as unknown as Drawing

// An artifact's icon: its kind's, or a document's for a markdown file.
export const iconOf = (artifact: {
  readonly kind: ArtifactKind
  readonly name: string
}): LucideIcon => registry[artifact.kind].icon({ item: artifact })

// What a bar's member shows as, on the taskbar and on its terminal's tab.
export const memberIcon = (member: BarMember): LucideIcon => registrationOf(member).icon(member)

// An icon on the bar: its one member's, or its stack's kind, whatever the members are.
export const slotIcon = (slot: BarSlot): LucideIcon =>
  slot.stack ? registry[slot.stack].stackIcon : memberIcon(slot.members[0]!)

// A stack's name, as its menu and its count say it.
export const stackNames = (stack: PaneKind): { readonly one: string; readonly many: string } =>
  registry[stack].names
