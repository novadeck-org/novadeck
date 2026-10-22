import type { ArtifactKind, ItemKind } from "@novadeck/core/items"
import { BookText, FileCode2, GitCompare, Globe, Image, type LucideIcon } from "lucide-react"

import type { StackKind } from "./bar"
import { iconOf, registry, stackNames } from "./registry"
import { context, describe, expect, it } from "./test"

// What the icons and names were before the registry, as the switches wrote them. The
// registry must give the same.
const oldKindIcons: Record<ArtifactKind, LucideIcon> = {
  image: Image,
  file: FileCode2,
  page: Globe,
  changes: GitCompare,
}
const oldIsMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path)
const oldIconOf = (artifact: { kind: ArtifactKind; name: string }): LucideIcon =>
  artifact.kind === "file" && oldIsMarkdown(artifact.name) ? BookText : oldKindIcons[artifact.kind]
const oldStackNames: Record<StackKind, { one: string; many: string }> = {
  plan: { one: "plan", many: "Plans" },
  image: { one: "image", many: "Images" },
  file: { one: "file", many: "Files" },
  page: { one: "page", many: "Pages" },
  changes: { one: "change", many: "Changes" },
}

describe("the registry", () => {
  context("what it holds", () => {
    it("has a registration for every kind of item, each under its own kind", () => {
      const kinds: Record<ItemKind, true> = {
        image: true,
        file: true,
        page: true,
        changes: true,
        plan: true,
      }
      expect(Object.keys(registry).toSorted()).toEqual(Object.keys(kinds).toSorted())
      for (const [key, registration] of Object.entries(registry))
        expect(registration.kind).toBe(key)
    })
  })

  context("icons", () => {
    it("gives an artifact the icon its kind and name gave it", () => {
      for (const [kind, name] of [
        ["image", "a.png"],
        ["file", "a.ts"],
        ["file", "a.md"],
        ["file", "a.markdown"],
        ["file", "a.MD"],
        ["page", "localhost"],
      ] as const)
        expect(iconOf({ kind, name }), `${kind} ${name}`).toBe(oldIconOf({ kind, name }))
    })
  })

  context("names", () => {
    it("names each stack as the taskbar did", () => {
      for (const stack of Object.keys(oldStackNames) as StackKind[])
        expect(stackNames(stack), stack).toEqual(oldStackNames[stack])
    })
  })
})
