import { companionKeyId, type ArtifactRef, type PlanSnapshot } from "../../model/companion"
import { context, describe, expect, it } from "../../test"
import { composeBar, moveSlot, ownMembers, pick, placedMembers, type BarSlot } from "./bar"
import {
  arrived,
  emptyPane,
  mailTab,
  openTab,
  paneOf,
  placedKey,
  planTab,
  show,
  type Pane,
} from "./pane"

const ref = (id: string, kind: ArtifactRef["kind"], name = `${id}.png`): ArtifactRef => ({
  id,
  kind,
  name,
  detail: "",
  version: 1,
})
const image = (id: string): ArtifactRef => ref(id, "image")
const home = ref("home", "file", "Home.tsx")
const preview = ref("preview", "page", "localhost:5173")
const session = { projectId: "p", workspaceSessionId: "s" }
const key = (terminalId: string) => ({ ...session, terminalId })
const plan = (name: string, role: PlanSnapshot["role"] = "root"): PlanSnapshot => ({
  ref: name,
  role,
  path: `${name}.md`,
  agent: "Codex",
  skill: true,
  writable: true,
  text: `# ${name}\n`,
  revision: "1",
})
const root = planTab("root")
const none = new Set<string>()

// Terminal 01's pane with its plan, and then `shown`, in that order.
const paneWith = (...shown: ArtifactRef[]): Pane =>
  shown.reduce(
    (pane, next) => show(pane, next, false),
    paneOf({ key: key("01"), plans: [plan("root")], shown: [] }),
  )

const barOf = (pane: Pane, messages = false, away = none): readonly BarSlot[] =>
  composeBar(pane, ownMembers(pane, away, messages))
const keys = (slots: readonly BarSlot[]): string[] => slots.map((slot) => slot.key)

describe("a terminal's taskbar", () => {
  context("when it lays out its icons", () => {
    it("gives each thing its own icon while it's the only one of its kind", () => {
      expect(keys(barOf(paneWith(image("hero"), home)))).toEqual([root, "hero", "home"])
    })

    it("stacks several images where the first one came", () => {
      const slots = barOf(paneWith(image("hero"), home, image("about"), preview))
      expect(keys(slots)).toEqual([root, "stack:image", "home", "preview"])
      expect(slots[1]!.members.map((member) => member.id)).toEqual(["hero", "about"])
    })

    it("stacks files and pages the same way, apart from the images", () => {
      const data = ref("data", "file", "projects.json")
      const docs = ref("docs", "page", "localhost:6006")
      const slots = barOf(paneWith(home, image("hero"), data, preview, docs))
      expect(keys(slots)).toEqual([root, "stack:file", "hero", "stack:page"])
    })

    it("stacks several plans", () => {
      const pane = paneOf({
        key: key("01"),
        plans: [plan("root"), plan("sub", "subagent")],
        shown: [],
      })
      expect(barOf(pane).map((slot) => [slot.key, slot.members.length])).toEqual([
        ["stack:plan", 2],
      ])
    })

    it("never stacks the messages, which come where they first came", () => {
      const pane = show(arrived(paneWith(image("hero")), mailTab), image("about"), false)
      expect(keys(barOf(pane, true))).toEqual([root, "stack:image", mailTab])
      // Without messages to show, there's no icon for them.
      expect(keys(barOf(pane, false))).toEqual([root, "stack:image"])
    })

    it("leaves out what's away and what's closed", () => {
      const pane = { ...paneWith(image("hero"), home), closed: [root] }
      expect(keys(barOf(pane, false, new Set(["hero"])))).toEqual(["home"])
    })
  })

  context("when another terminal's item is placed on it", () => {
    const theirs = paneWith(image("shot"))
    const panes = { [companionKeyId(key("01"))]: theirs }
    const placed = placedKey("01", { kind: "artifact", id: "shot" })

    it("shows it as its terminal has it now, saying where it's from", () => {
      const members = placedMembers(
        [{ from: "01", item: { kind: "artifact", id: "shot" }, to: "02" }],
        "02",
        session,
        panes,
      )
      expect(members).toEqual([
        expect.objectContaining({ id: placed, key: "shot", source: key("01"), placed: true }),
      ])
    })

    it("shows nothing for what its terminal no longer has, or what's placed elsewhere", () => {
      const placements = [
        { from: "01", item: { kind: "artifact", id: "gone" }, to: "02" },
        { from: "01", item: { kind: "plan", ref: "root" }, to: "03" },
      ] as const
      expect(placedMembers(placements, "02", session, panes)).toEqual([])
    })

    it("stacks it with this terminal's own of its kind, in the order they came", () => {
      const mine = { ...show(emptyPane(key("02")), image("hero"), false) }
      const here = arrived(mine, placed)
      const members = placedMembers(
        [{ from: "01", item: { kind: "artifact", id: "shot" }, to: "02" }],
        "02",
        session,
        panes,
      )
      const slots = composeBar(here, [...ownMembers(here, none, false), ...members])
      expect(slots.map((slot) => slot.members.map((member) => member.id))).toEqual([
        ["hero", placed],
      ])
    })
  })

  context("when the person moves an icon", () => {
    it("moves its items with it, a stack's together, anywhere on the bar", () => {
      let pane = arrived(paneWith(image("hero"), home, image("about")), mailTab)
      const bar = () => barOf(pane, true)
      // Messages to the front, then the plan to the end.
      pane = moveSlot(pane, bar(), 3, 0)
      pane = moveSlot(pane, bar(), 1, 3)
      expect(keys(bar())).toEqual([mailTab, "stack:image", "home", root])
    })

    it("leaves what isn't on the bar where it was", () => {
      const pane = paneWith(home, image("hero"), preview)
      // The image is undocked: the bar swaps Home.tsx and the preview around it.
      const away = new Set(["hero"])
      const moved = moveSlot(pane, barOf(pane, false, away), 2, 1)
      expect(moved.order).toEqual([root, "preview", "hero", "home"])
    })
  })

  context("when a stack's icon is clicked", () => {
    const stack = (pane: Pane): BarSlot => barOf(pane).find((slot) => slot.stack === "image")!

    it("opens what's new, else what's open, else the latest", () => {
      const two = paneWith(image("a"), image("b"))
      expect(pick(stack(two), "").id).toBe("b")
      const read = openTab(openTab(two, "b"), "a")
      expect(pick(stack(read), "a").id).toBe("a")
      expect(pick(stack(read), root).id).toBe("b")
    })

    it("opens a stack of plans to the one rewritten since it was read, else the root plan", () => {
      const plans = paneOf({
        key: key("01"),
        plans: [plan("root"), plan("sub", "subagent")],
        shown: [],
      })
      // A plan reported for the first time is unread: the first one is.
      expect(pick(barOf(plans)[0]!, planTab("sub")).id).toBe(root)
      const read = { ...plans, plans: plans.plans.map((each) => ({ ...each, seen: each.writes })) }
      expect(pick(barOf(read)[0]!, "").id).toBe(root)
      expect(pick(barOf(read)[0]!, planTab("sub")).id).toBe(planTab("sub"))
    })

    it("opens something that may hold secrets only when the stack holds nothing else", () => {
      const qr: ArtifactRef = { ...image("qr"), held: true }
      expect(pick(stack(paneWith(image("shot"), qr)), "").id).toBe("shot")
      expect(pick(stack(paneWith(qr, { ...image("key"), held: true })), "").id).toBe("key")
    })
  })
})
