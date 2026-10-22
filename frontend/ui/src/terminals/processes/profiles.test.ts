import type { ArtifactKind, Item } from "@novadeck/core/items"
import { itemFixture } from "@novadeck/core/testing"
import {
  BookText,
  FileCode2,
  FileText,
  GitCompare,
  Globe,
  Image,
  type LucideIcon,
} from "lucide-react"

import { context, describe, expect, it } from "../../test"
import { windowProfile } from "./profiles"

// What a window's icon was before it read the companion's registry.
const kindIcons: Record<ArtifactKind, LucideIcon> = {
  image: Image,
  file: FileCode2,
  page: Globe,
  changes: GitCompare,
}
const oldWindowIcon = (item: Pick<Item, "kind" | "name"> | undefined): LucideIcon =>
  !item || item.kind === "plan"
    ? FileText
    : item.kind === "file" && /\.(md|markdown)$/i.test(item.name)
      ? BookText
      : kindIcons[item.kind]

describe("a window undocked from a terminal's companion", () => {
  context("presents as what it shows", () => {
    it("keeps the icon each kind of item gave it, a subagent's plan too", () => {
      const items = [
        itemFixture("plan", "01", {
          kind: "plan",
          name: "plan.md",
          plan: { agent: "Codex", role: "root", source: "file" },
        }),
        itemFixture("sub", "01", {
          kind: "plan",
          name: "old-migration.md",
          plan: { agent: "Codex", role: "subagent", source: "text" },
        }),
        itemFixture("notes", "01", { kind: "file", name: "notes.md" }),
        itemFixture("docs", "01", { kind: "file", name: "README.MARKDOWN" }),
        itemFixture("app", "01", { kind: "file", name: "App.tsx" }),
        itemFixture("hero", "01", { kind: "image", name: "hero.png" }),
        itemFixture("web", "01", { kind: "page", name: "localhost:5173", path: null }),
      ]
      for (const item of items)
        expect(windowProfile(item).icon, item.name).toBe(oldWindowIcon(item))
      expect(windowProfile(items[1]).icon).toBe(FileText)
      expect(windowProfile(undefined).icon).toBe(FileText)
    })
  })
})
