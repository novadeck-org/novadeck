import type { ArtifactKind, CompanionItem } from "@novadeck/core/companion"
import { messagesKey } from "@novadeck/core/companion-bar"
import { itemFixture } from "@novadeck/core/testing"
import {
  BookText,
  FileCode2,
  FileStack,
  FileText,
  Globe,
  Image,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react"

import type { BarMember, BarSlot, StackKind } from "./bar"
import type { PaneKind } from "./registration"
import { iconOf, kindOf, memberIcon, registry, slotIcon, stackNames } from "./registry"
import { lookOf, type SlotActions } from "./TaskbarSlot"
import { context, describe, expect, it } from "./test"

// What the icons, names and labels were before the registry, as the switches wrote them. The
// registry must give the same for every shape of member.
const oldKindIcons: Record<ArtifactKind, LucideIcon> = {
  image: Image,
  file: FileCode2,
  page: Globe,
}
const oldIsMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path)
const oldIconOf = (artifact: { kind: ArtifactKind; name: string }): LucideIcon =>
  artifact.kind === "file" && oldIsMarkdown(artifact.name) ? BookText : oldKindIcons[artifact.kind]
const oldMemberIcon = (member: BarMember): LucideIcon =>
  member.kind === "messages"
    ? MessagesSquare
    : member.item.kind === "plan"
      ? member.item.plan?.role === "subagent"
        ? FileStack
        : FileText
      : oldIconOf({ kind: member.item.kind, name: member.item.name })
const oldSlotIcon = (slot: BarSlot): LucideIcon =>
  slot.stack === "plan"
    ? FileText
    : slot.stack
      ? oldKindIcons[slot.stack]
      : oldMemberIcon(slot.members[0]!)
const oldStackNames: Record<StackKind, { one: string; many: string }> = {
  plan: { one: "plan", many: "Plans" },
  image: { one: "image", many: "Images" },
  file: { one: "file", many: "Files" },
  page: { one: "page", many: "Pages" },
}
const oldTitleOf = (path: string, text: string): string =>
  /^# (.+)$/m.exec(text)?.[1]?.trim() ?? path.split("/").at(-1) ?? path
const oldLookOf = (
  member: BarMember,
  plans: Record<string, { text: string }>,
  origin: string | undefined,
) => {
  if (member.kind === "messages")
    return { icon: oldMemberIcon(member), name: "Messages", label: "Messages" }
  const { item } = member
  const title = oldTitleOf(item.name, plans[item.id]?.text ?? "")
  const look =
    item.kind === "plan"
      ? {
          icon: oldMemberIcon(member),
          name: title,
          label: `${item.plan?.role === "subagent" ? "Subagent plan" : "Plan"}: ${title}`,
        }
      : { icon: oldMemberIcon(member), name: item.name, label: item.name }
  if (!member.placed) return look
  const from = origin ?? "another terminal"
  return { ...look, name: `${look.name} · from ${from}`, label: `${look.label}, from ${from}` }
}

const itemMember = (item: CompanionItem, placed = false): BarMember => ({
  kind: "item",
  key: item.id,
  item,
  placed,
  fresh: false,
})
const plan = itemFixture("plan", "01", {
  kind: "plan",
  name: "plan.md",
  path: "/p/plan.md",
  plan: { agent: "Codex", role: "root", source: "file" },
})
const subagent = itemFixture("sub", "01", {
  kind: "plan",
  name: "old-migration.md",
  plan: { agent: "Codex", role: "subagent", source: "text" },
})
const markdown = itemFixture("voice", "01", { kind: "file", name: "brand-voice.md" })
const upper = itemFixture("readme", "01", { kind: "file", name: "README.MARKDOWN" })
const code = itemFixture("app", "01", { kind: "file", name: "App.tsx" })
const picture = itemFixture("hero", "01", { kind: "image", name: "hero.png" })
const web = itemFixture("web", "01", { kind: "page", name: "localhost:5173", path: null })
const messages: BarMember = { kind: "messages", key: messagesKey }

const shapes: Record<string, BarMember> = {
  plan: itemMember(plan),
  "subagent plan": itemMember(subagent),
  "markdown file": itemMember(markdown),
  "markdown file, upper case": itemMember(upper),
  "code file": itemMember(code),
  image: itemMember(picture),
  page: itemMember(web),
  messages,
  "placed plan": itemMember(plan, true),
  "placed markdown file": itemMember(markdown, true),
}

describe("the registry", () => {
  context("what it holds", () => {
    it("has a registration for every kind, each under its own kind", () => {
      const kinds: Record<PaneKind, true> = {
        image: true,
        file: true,
        page: true,
        plan: true,
        messages: true,
      }
      expect(Object.keys(registry).toSorted()).toEqual(Object.keys(kinds).toSorted())
      for (const [key, registration] of Object.entries(registry))
        expect(registration.kind).toBe(key)
    })

    it("names every member by its kind", () => {
      expect(Object.values(shapes).map(kindOf)).toEqual([
        "plan",
        "plan",
        "file",
        "file",
        "file",
        "image",
        "page",
        "messages",
        "plan",
        "file",
      ])
    })
  })

  context("icons", () => {
    it("gives each shape of member the icon the switches gave it", () => {
      for (const [shape, member] of Object.entries(shapes))
        expect(memberIcon(member), shape).toBe(oldMemberIcon(member))
      expect(memberIcon(shapes["subagent plan"]!)).toBe(FileStack)
      expect(memberIcon(shapes["markdown file"]!)).toBe(BookText)
    })

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

    it("gives a stack its kind's icon whatever its members are, and a single slot its member's", () => {
      const stacks: Record<StackKind, BarMember[]> = {
        plan: [shapes.plan!, shapes["subagent plan"]!],
        file: [shapes["markdown file"]!, shapes["markdown file, upper case"]!],
        image: [shapes.image!, shapes.image!],
        page: [shapes.page!, shapes.page!],
      }
      for (const [stack, members] of Object.entries(stacks) as [StackKind, BarMember[]][]) {
        const slot: BarSlot = { key: `stack-${stack}`, stack, members }
        expect(slotIcon(slot), stack).toBe(oldSlotIcon(slot))
      }
      // A stack of markdown files shows code's icon, and a stack of plans a plan's, not a
      // subagent's.
      expect(slotIcon({ key: "s", stack: "file", members: stacks.file })).toBe(FileCode2)
      expect(slotIcon({ key: "s", stack: "plan", members: stacks.plan })).toBe(FileText)
      for (const [shape, member] of Object.entries(shapes)) {
        const slot: BarSlot = { key: member.key, stack: null, members: [member] }
        expect(slotIcon(slot), shape).toBe(oldSlotIcon(slot))
      }
    })
  })

  context("names", () => {
    it("names each stack as the taskbar did", () => {
      for (const stack of Object.keys(oldStackNames) as StackKind[])
        expect(stackNames(stack), stack).toEqual(oldStackNames[stack])
    })

    it("looks as it did for every shape of member, placed or not", () => {
      const plans = { [plan.id]: { text: "# Home for Studio\n\nBody" } }
      const actions = {
        plans,
        originOf: () => "Dev server",
      } as unknown as SlotActions
      for (const [shape, member] of Object.entries(shapes))
        expect(lookOf(member, actions), shape).toEqual(oldLookOf(member, plans, "Dev server"))
      // A plan before it loads is named by its file; one placed from a terminal that's gone
      // says so in general words.
      const unloaded = { plans: {}, originOf: () => undefined } as unknown as SlotActions
      for (const [shape, member] of Object.entries(shapes))
        expect(lookOf(member, unloaded), shape).toEqual(oldLookOf(member, {}, undefined))
    })
  })
})
