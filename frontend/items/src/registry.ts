import type { ShownKind, Item, ItemKind } from "@novadeck/core/items"
import type { LucideIcon } from "lucide-react"

import { changes } from "./kinds/changes"
import { file } from "./kinds/file"
import { image } from "./kinds/image"
import { page } from "./kinds/page"
import { plan } from "./kinds/plan"
import type { ItemRegistration, LookContext, Registry } from "./registration"

// Every kind of item, by its registration. A new artifact type is one folder in `kinds/`
// and one line here, with its data parts in core; a kind that core adds without one fails
// to compile, since `Registry` maps every `ItemKind`.
export const registry = { image, file, page, changes, plan } satisfies Registry

// The registration that draws `item`.
export const registrationOf = (item: Pick<Item, "kind">): ItemRegistration => registry[item.kind]

// An artifact's icon: its kind's, or a document's for a markdown file.
export const iconOf = (artifact: { readonly kind: ShownKind; readonly name: string }): LucideIcon =>
  registry[artifact.kind].icon(artifact)

// How an item looks: its icon, its name as a peek and a menu say it, and how its button
// reads to assistive technology.
export type Look = { readonly icon: LucideIcon; readonly name: string; readonly label: string }

export const itemLook = (item: Item, context: LookContext): Look => {
  const registration = registrationOf(item)
  return { icon: registration.icon(item), ...registration.look(item, context) }
}

// A stack's icon, its kind's whatever its items are.
export const stackIcon = (kind: ItemKind): LucideIcon => registry[kind].stackIcon

// A stack's name, as its menu and its count say it.
export const stackNames = (kind: ItemKind): { readonly one: string; readonly many: string } =>
  registry[kind].names
