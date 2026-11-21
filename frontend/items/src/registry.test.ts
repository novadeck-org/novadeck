import type { ShownKind, ItemKind } from "@novadeck/core/items"
import {
  AudioLines,
  Box,
  BookText,
  FileCode2,
  FileType,
  Film,
  Folder,
  GitCompare,
  Globe,
  Image,
  type LucideIcon,
  PanelTop,
} from "lucide-react"

import type { StackKind } from "./bar/bar"
import { iconOf, registry, stackNames } from "./registry"
import { context, describe, expect, it } from "./test"

// What the icons and names were before the registry, as the switches wrote them. The
// registry must give the same.
const oldKindIcons: Record<ShownKind, LucideIcon> = {
  image: Image,
  video: Film,
  audio: AudioLines,
  pdf: FileType,
  model: Box,
  file: FileCode2,
  folder: Folder,
  page: Globe,
  changes: GitCompare,
}
const oldIsMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path)
const oldIconOf = (artifact: { kind: ShownKind; name: string }): LucideIcon =>
  artifact.kind === "file" && oldIsMarkdown(artifact.name) ? BookText : oldKindIcons[artifact.kind]
const oldStackNames: Record<StackKind, { one: string; many: string }> = {
  plan: { one: "plan", many: "Plans" },
  image: { one: "image", many: "Images" },
  video: { one: "video", many: "Videos" },
  audio: { one: "recording", many: "Recordings" },
  pdf: { one: "PDF", many: "PDFs" },
  model: { one: "3D model", many: "3D models" },
  file: { one: "file", many: "Files" },
  folder: { one: "folder", many: "Folders" },
  page: { one: "page", many: "Pages" },
  changes: { one: "change", many: "Changes" },
  shells: { one: "shells", many: "Shells" },
}

describe("the registry", () => {
  context("what it holds", () => {
    it("has a registration for every kind of item, each under its own kind", () => {
      const kinds: Record<ItemKind, true> = {
        image: true,
        video: true,
        audio: true,
        pdf: true,
        model: true,
        file: true,
        folder: true,
        page: true,
        changes: true,
        plan: true,
        shells: true,
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

    it("gives a file the icon of its path's type, whatever its title", () => {
      expect(iconOf({ kind: "file", name: "Design notes", path: "/work/notes.md" })).toBe(BookText)
      expect(iconOf({ kind: "file", name: "Strip", path: "/work/strip.html" })).toBe(PanelTop)
      expect(iconOf({ kind: "file", name: "notes.md", path: "/work/notes.ts" })).toBe(FileCode2)
    })
  })

  context("names", () => {
    it("names each stack as the taskbar did", () => {
      for (const stack of Object.keys(oldStackNames) as StackKind[])
        expect(stackNames(stack), stack).toEqual(oldStackNames[stack])
    })
  })
})
