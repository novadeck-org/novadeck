import type { ShownKind, Item } from "@novadeck/core/items"
import { messagesKey } from "@novadeck/core/items/companion-bar"
import { itemFixture } from "@novadeck/core/testing"
import {
  BookText,
  FileCode2,
  FileStack,
  FileText,
  GitCompare,
  Globe,
  Image,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react"

import type { BarMember, BarSlot, StackKind } from "../../bar/bar"
import { lookOf, type SlotActions } from "../../bar/TaskbarSlot"
import type { ItemStore } from "../../store/item-store"
import { context, describe, expect, it } from "../../test"
import { slotIcon, terminalDrawing } from "./drawing"
import { noLinks, type MessagesHandle } from "./messages/messages"

// What the icons, names and labels were before the registry, as the switches wrote them. A
// terminal's drawing of its bar, from the registry and its own messages, must give the same
// for every shape of member.
const expectedKindIcons: Record<ShownKind, LucideIcon> = {
  image: Image,
  file: FileCode2,
  page: Globe,
  changes: GitCompare,
}
const expectedIsMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path)
const expectedIconOf = (artifact: { kind: ShownKind; name: string }): LucideIcon =>
  artifact.kind === "file" && expectedIsMarkdown(artifact.name)
    ? BookText
    : expectedKindIcons[artifact.kind]
const expectedMemberIcon = (member: BarMember): LucideIcon =>
  member.kind === "messages"
    ? MessagesSquare
    : member.item.kind === "plan"
      ? member.item.plan?.role === "subagent"
        ? FileStack
        : FileText
      : expectedIconOf({ kind: member.item.kind, name: member.item.name })
const expectedSlotIcon = (slot: BarSlot): LucideIcon =>
  slot.stack === "plan"
    ? FileText
    : slot.stack
      ? expectedKindIcons[slot.stack]
      : expectedMemberIcon(slot.members[0]!)
const expectedTitleOf = (path: string, text: string): string =>
  /^# (.+)$/m.exec(text)?.[1]?.trim() ?? path.split("/").at(-1) ?? path
const expectedLookOf = (
  member: BarMember,
  plans: Record<string, { text: string }>,
  origin: string | undefined,
) => {
  if (member.kind === "messages")
    return { icon: expectedMemberIcon(member), name: "Messages", label: "Messages" }
  const { item } = member
  const title = expectedTitleOf(item.name, plans[item.id]?.text ?? "")
  const look =
    item.kind === "plan"
      ? {
          icon: expectedMemberIcon(member),
          name: title,
          label: `${item.plan?.role === "subagent" ? "Subagent plan" : "Plan"}: ${title}`,
        }
      : { icon: expectedMemberIcon(member), name: item.name, label: item.name }
  if (!member.placed) return look
  const from = origin ?? "another terminal"
  return { ...look, name: `${look.name} · from ${from}`, label: `${look.label}, from ${from}` }
}

const itemMember = (item: Item, placed = false): BarMember => ({
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
const change = itemFixture("change", "01", { kind: "changes", name: "Changes", path: "/repo" })
const messages: BarMember = { kind: "messages", key: messagesKey }

const shapes: Record<string, BarMember> = {
  plan: itemMember(plan),
  "subagent plan": itemMember(subagent),
  "markdown file": itemMember(markdown),
  "markdown file, upper case": itemMember(upper),
  "code file": itemMember(code),
  image: itemMember(picture),
  page: itemMember(web),
  changes: itemMember(change),
  messages,
  "placed plan": itemMember(plan, true),
  "placed markdown file": itemMember(markdown, true),
}

describe("a terminal's drawing of its bar", () => {
  context("icons", () => {
    it("gives each shape of member the icon the switches gave it", () => {
      const icon = (member: BarMember) =>
        slotIcon({ key: member.key, stack: null, members: [member] })
      for (const [shape, member] of Object.entries(shapes))
        expect(icon(member), shape).toBe(expectedMemberIcon(member))
      expect(icon(shapes["subagent plan"]!)).toBe(FileStack)
      expect(icon(shapes["markdown file"]!)).toBe(BookText)
    })

    it("gives a stack its kind's icon whatever its members are, and a single slot its member's", () => {
      const stacks: Record<StackKind, BarMember[]> = {
        plan: [shapes.plan!, shapes["subagent plan"]!],
        file: [shapes["markdown file"]!, shapes["markdown file, upper case"]!],
        image: [shapes.image!, shapes.image!],
        page: [shapes.page!, shapes.page!],
        changes: [shapes.changes!, shapes.changes!],
      }
      for (const [stack, members] of Object.entries(stacks) as [StackKind, BarMember[]][]) {
        const slot: BarSlot = { key: `stack-${stack}`, stack, members }
        expect(slotIcon(slot), stack).toBe(expectedSlotIcon(slot))
      }
      // A stack of markdown files shows code's icon, and a stack of plans a plan's, not a
      // subagent's.
      expect(slotIcon({ key: "s", stack: "file", members: stacks.file })).toBe(FileCode2)
      expect(slotIcon({ key: "s", stack: "plan", members: stacks.plan })).toBe(FileText)
      for (const [shape, member] of Object.entries(shapes)) {
        const slot: BarSlot = { key: member.key, stack: null, members: [member] }
        expect(slotIcon(slot), shape).toBe(expectedSlotIcon(slot))
      }
    })
  })

  context("names", () => {
    it("looks as it did for every shape of member, placed or not", () => {
      const plans = { [plan.id]: { text: "# Home for Studio\n\nBody" } }
      const actionsOf = (
        held: Record<string, { text: string }>,
        origin: string | undefined,
      ): SlotActions =>
        ({
          draw: terminalDrawing({
            plans: held as Parameters<typeof terminalDrawing>[0]["plans"],
            itemStore: {} as ItemStore,
            target: { projectId: "project", workspaceSessionId: "initial" },
            messagesHandle: {} as MessagesHandle,
            links: noLinks,
          }),
          originOf: () => origin,
        }) as unknown as SlotActions
      const actions = actionsOf(plans, "Dev server")
      for (const [shape, member] of Object.entries(shapes))
        expect(lookOf(member, actions), shape).toEqual(expectedLookOf(member, plans, "Dev server"))
      // A plan before it loads is named by its file; one placed from a terminal that's gone
      // says so in general words.
      const unloaded = actionsOf({}, undefined)
      for (const [shape, member] of Object.entries(shapes))
        expect(lookOf(member, unloaded), shape).toEqual(expectedLookOf(member, {}, undefined))
    })
  })
})
