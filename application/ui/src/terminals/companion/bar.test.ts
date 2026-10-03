import type { CompanionItem, ItemId } from "../../model/companion"
import { emptyBar, messagesKey, type Bar, type BarKey } from "../../model/companion-bar"
import { context, describe, expect, it } from "../../test"
import { itemFixture } from "../../test/fixtures"
import type { BarDrag } from "../drag-session"
import {
  barMembers,
  composeBar,
  dropOutcome,
  pick,
  shownTab,
  undocks,
  type BarMember,
  type BarSlot,
} from "./bar"

const image = (id: string, item: Partial<CompanionItem> = {}) =>
  itemFixture(id, "01", { kind: "image", name: `${id}.png`, path: `/p/${id}.png`, ...item })
const plan = (id: string, role: "root" | "subagent" = "root") =>
  itemFixture(id, "01", { kind: "plan", name: id, plan: { agent: "Codex", role, source: "file" } })
const root = plan("root")
const home = itemFixture("home", "01")
const preview = itemFixture("preview", "01", { kind: "page", path: null, url: "http://x/" })

// Terminal 01's bar holding `items` in the order they came, its messages when it has
// them, and which items are new.
const membersOf = (
  items: readonly CompanionItem[],
  {
    bar = { ...emptyBar, order: items.map((item) => item.id) },
    messages = false,
    fresh = [],
  }: { bar?: Bar; messages?: boolean; fresh?: readonly ItemId[] } = {},
): readonly BarMember[] =>
  barMembers({
    terminalId: "01",
    bar,
    items,
    fresh: Object.fromEntries(fresh.map((id) => [id, true])),
    messages,
  })
const barOf = (items: readonly CompanionItem[], options?: Parameters<typeof membersOf>[1]) =>
  composeBar(
    options?.bar ?? { ...emptyBar, order: items.map((item) => item.id) },
    membersOf(items, options),
  )
const keys = (slots: readonly BarSlot[]): string[] => slots.map((slot) => slot.key)
const memberKeys = (slot: BarSlot): BarKey[] => slot.members.map((member) => member.key)

// A bar with its pane open to `tab`.
const open = (tab: BarKey | null): Bar => ({ ...emptyBar, tab, open: true })

// A stack of `members`, of their kind.
const stack = (members: readonly BarMember[]): BarSlot => ({
  key: "stack",
  stack: members[0]?.kind === "item" ? members[0].item.kind : null,
  members,
})

// A drag that ended as `ended` says.
const drag = (ended: Partial<BarDrag>): BarDrag => ({
  from: "01",
  name: "",
  undocks: true,
  over: null,
  onBar: false,
  place: null,
  ...ended,
})

describe("a terminal's taskbar", () => {
  context("when it lays out its icons", () => {
    it("gives each thing its own icon while it's the only one of its kind", () => {
      expect(keys(barOf([root, image("hero"), home]))).toEqual(["root", "hero", "home"])
    })

    it("stacks several of a kind where the first one came", () => {
      const slots = barOf([root, image("hero"), home, image("about"), preview])
      expect(keys(slots)).toEqual(["root", "stack:image", "home", "preview"])
      expect(memberKeys(slots[1]!)).toEqual(["hero", "about"])
    })

    it("stacks several plans", () => {
      expect(keys(barOf([root, home, plan("helper", "subagent")]))).toEqual(["stack:plan", "home"])
    })

    it("never stacks the messages, which come where the bar has them", () => {
      const bar: Bar = { ...emptyBar, order: [root.id, messagesKey, home.id] }
      expect(keys(barOf([root, home], { bar, messages: true }))).toEqual([
        "root",
        messagesKey,
        "home",
      ])
    })

    it("puts what the order doesn't know yet after, as given", () => {
      const bar = { ...emptyBar, order: [home.id] }
      expect(keys(barOf([root, home], { bar, messages: true }))).toEqual([
        "home",
        "root",
        messagesKey,
      ])
    })

    it("leaves out what's hidden, and what another bar or window holds", () => {
      const bar: Bar = { ...emptyBar, order: [home.id], hidden: [root.id, messagesKey] }
      const elsewhere = [
        itemFixture("there", "02"),
        itemFixture("windowed", "01", { holder: { windowId: "w1" } }),
      ]
      expect(keys(barOf([root, home, ...elsewhere], { bar, messages: true }))).toEqual(["home"])
    })
  })

  context("when it holds something shown from another terminal", () => {
    it("says so, and keeps it from undocking", () => {
      const placed = itemFixture("placed", "02", { holder: { terminalId: "01" } })
      const [member] = membersOf([placed])
      expect(member).toMatchObject({ kind: "item", placed: true })
      expect(undocks([member!])).toBe(false)
      expect(undocks(membersOf([home]))).toBe(true)
    })
  })

  it("marks what's new", () => {
    const [first, second] = membersOf([home, preview], { fresh: [preview.id] })
    expect([first, second].map((member) => member?.kind === "item" && member.fresh)).toEqual([
      false,
      true,
    ])
  })

  context("when its pane opens", () => {
    it("shows its tab while that's on the bar, else its first plan, else the first that may show unpicked", () => {
      const held = image("secret", { held: true })
      expect(shownTab(open(home.id), membersOf([root, home]))).toBe(home.id)
      expect(shownTab(open("gone" as ItemId), membersOf([home, root]))).toBe(root.id)
      expect(shownTab(open(null), membersOf([held, home]))).toBe(home.id)
      expect(shownTab(open(null), membersOf([held]))).toBeNull()
    })
  })

  context("when a stack's icon is clicked", () => {
    it("opens what's new, else what's open, else the latest", () => {
      const images = [image("hero"), image("about"), image("mobile")]
      expect(pick(stack(membersOf(images, { fresh: [images[0]!.id] })), null).key).toBe("hero")
      expect(pick(stack(membersOf(images)), images[1]!.id).key).toBe("about")
      expect(pick(stack(membersOf(images)), null).key).toBe("mobile")
    })

    it("opens a stack of plans to the one rewritten since it was read, else the root plan", () => {
      const helper = plan("helper", "subagent")
      expect(pick(stack(membersOf([helper, root], { fresh: [helper.id] })), null).key).toBe(
        "helper",
      )
      expect(pick(stack(membersOf([helper, root])), null).key).toBe("root")
    })

    it("opens something that may hold secrets only when the stack holds nothing else", () => {
      const secret = image("secret", { held: true })
      expect(
        pick(stack(membersOf([image("hero"), secret], { fresh: [secret.id] })), null).key,
      ).toBe("hero")
      expect(pick(stack(membersOf([secret])), null).key).toBe("secret")
    })
  })

  context("when what's dragged off it is dropped", () => {
    const place = { canvas: { x: 240, y: 120 } }

    it("moves it onto the other terminal's bar, a stack's each", () => {
      const images = membersOf([image("hero"), image("about")])
      expect(dropOutcome(images, drag({ over: "02", onBar: true }), "01")).toEqual({
        kind: "place",
        itemIds: ["hero", "about"],
        terminalId: "02",
      })
    })

    it("undocks one thing dropped on free space", () => {
      expect(dropOutcome(membersOf([home]), drag({ place }), "01")).toEqual({
        kind: "undock",
        itemId: "home",
        place,
      })
    })

    it("does nothing back on its own bar, for the messages, or for a stack in free space", () => {
      expect(dropOutcome(membersOf([home]), drag({ over: "01", onBar: true }), "01")).toBeNull()
      const messages = membersOf([], { messages: true })
      expect(dropOutcome(messages, drag({ over: "02", onBar: true }), "01")).toBeNull()
      expect(dropOutcome(membersOf([home, preview]), drag({ place }), "01")).toBeNull()
    })
  })
})
