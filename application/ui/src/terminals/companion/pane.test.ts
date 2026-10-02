import type { ArtifactRef } from "../../model/companion"
import { context, describe, expect, it } from "../../test"
import {
  arrived,
  arrivedAgain,
  close,
  emptyPane,
  itemKey,
  mailTab,
  movableOf,
  openPane,
  openTab,
  placedKey,
  planTab,
  reopen,
  seen,
  settle,
  show,
  shownTab,
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
const root = planTab("root")
const key = { projectId: "p", workspaceSessionId: "s", terminalId: "t" }
const pane: Pane = { ...emptyPane(key), tab: root, home: root }
const fresh = (each: Pane): number => each.artifacts.filter((shown) => shown.fresh).length
// What the pane shows with everything it holds on the bar, and the messages.
const showing = (each: Pane): string =>
  shownTab(each, (tab) => tab === mailTab || each.artifacts.some((shown) => shown.id === tab))

describe("companion pane", () => {
  context("when the agent shows something", () => {
    const shown = show(pane, home, false)

    it("waits, marked new, without opening", () => {
      expect(shown.open).toBe(false)
      expect(shown.tab).toBe(root)
      expect(fresh(shown)).toBe(1)
    })

    it("lists each thing once, and joins the bar's order once", () => {
      expect(show(shown, home, false).artifacts).toHaveLength(1)
      expect(show(shown, home, false).order).toEqual(["home"])
    })

    it("opens to what's new when no tab is chosen", () => {
      const opened = openPane(show(shown, preview, false))
      expect(opened.open).toBe(true)
      expect(opened.tab).toBe(preview.id)
      expect(fresh(opened)).toBe(1)
    })
  })

  context("when the user asked for it", () => {
    it("opens straight to it, not new", () => {
      const shown = show(pane, home, true)
      expect(shown).toMatchObject({ open: true, tab: home.id })
      expect(fresh(shown)).toBe(0)
    })
  })

  context("when a tab is looked at", () => {
    it("is no longer new", () => {
      expect(fresh(openTab(show(pane, home, false), home.id))).toBe(0)
    })
  })

  context("when the user closes something from the taskbar", () => {
    const ordered: Pane = { ...pane, tab: mailTab, order: [root, "home", mailTab] }

    it("lets what was shown go, and the pane falls back to the plan", () => {
      const closed = close(show({ ...ordered, tab: "home" }, home, false), "home")
      expect(closed.artifacts).toEqual([])
      expect(closed.closed).toEqual([])
      expect(closed.tab).toBe(root)
    })

    it("keeps a plan or the messages, off the bar", () => {
      const closed = close(close(ordered, mailTab), root)
      expect(closed.closed).toEqual([mailTab, root])
      expect(closed.order).toEqual(["home"])
    })

    it("hides the pane when it closes what the pane shows", () => {
      const open = { ...ordered, open: true }
      expect(close(open, mailTab).open).toBe(false)
      expect(close(open, root).open).toBe(true)
    })

    it("brings it back last when it reopens", () => {
      const reopened = reopen(close(ordered, root), root)
      expect(reopened.closed).toEqual([])
      expect(reopened.order).toEqual(["home", mailTab, root])
      expect(reopen(ordered, root)).toBe(ordered)
    })

    it("sends what was shown to the end when it's shown again", () => {
      let shown = show(pane, home, false)
      for (const next of [image("hero"), preview]) shown = show(shown, next, false)
      expect(show(close(shown, "home"), home, false).order).toEqual(["hero", "preview", "home"])
    })
  })

  context("when something arrives on the bar", () => {
    it("joins the end once", () => {
      expect(arrived(arrived(pane, "a"), "a").order).toEqual(["a"])
    })

    it("comes last again when it arrives again", () => {
      const placed = placedKey("02", { kind: "artifact", id: "hero" })
      const again = arrivedAgain({ ...pane, order: [placed, "home"] }, placed)
      expect(again.order).toEqual(["home", placed])
      expect(arrivedAgain(again, placed)).toBe(again)
    })
  })

  context("when the person looks at an item on another terminal's bar", () => {
    it("is seen in its own terminal's pane, without opening it there", () => {
      const looked = seen(show(pane, home, false), "home")
      expect(looked).toMatchObject({ open: false, artifacts: [{ id: "home", fresh: false }] })
      expect(seen(looked, "home")).toBe(looked)
    })
  })

  context("when the agent shows something again", () => {
    it("takes its new version in place, new again", () => {
      const read = openTab(show(pane, home, false), home.id)
      const again = show(read, { ...home, version: 2, detail: "lines 1–5" }, false)
      expect(again.artifacts).toMatchObject([
        { id: "home", version: 2, detail: "lines 1–5", fresh: true },
      ])
    })
  })

  context("when it was shown before this session", () => {
    it("is listed as already seen, and opens nothing even if asked for", () => {
      const listed = show(pane, home, true, true)
      expect(listed).toMatchObject({ open: false, artifacts: [{ id: "home", fresh: false }] })
      expect(listed.tab).toBe(pane.tab)
    })
  })

  context("when what it shows may hold secrets", () => {
    const env: ArtifactRef = { ...ref("env", "file", ".env"), held: true }

    it("isn't what opening the pane goes to, though it's new", () => {
      expect(openPane(show(show(pane, home, false), env, false)).tab).toBe("home")
      expect(openPane(show(pane, env, false)).tab).toBe(root)
    })

    it("isn't what the pane falls back to when its plan or what it showed goes", () => {
      // The plan is gone, and the user closed what they read.
      const left = close(openTab(show(show(pane, env, false), home, false), "home"), "home")
      expect(showing(left)).toBe("")
      expect(showing(show(left, preview, false))).toBe("preview")
    })

    it("shows when the user picks it", () => {
      expect(showing(openTab(show(pane, env, false), "env"))).toBe("env")
    })
  })

  context("when the pane has nothing left to show", () => {
    it("closes, unless it shows the messages or something placed here", () => {
      const open = { ...pane, open: true, tab: "gone" }
      expect(settle(open).open).toBe(false)
      expect(settle({ ...open, tab: mailTab }).open).toBe(true)
      const placed = placedKey("02", { kind: "plan", ref: "root" })
      expect(settle({ ...open, tab: placed }).open).toBe(true)
    })
  })
})

describe("item keys", () => {
  it("name a plan by its ref and something shown by its id, and read back the same", () => {
    const plan = { kind: "plan", ref: "root" } as const
    const shown = { kind: "artifact", id: "hero" } as const
    expect(itemKey(plan)).toBe(root)
    expect(movableOf(itemKey(plan))).toEqual(plan)
    expect(movableOf(itemKey(shown))).toEqual(shown)
  })

  it("never name the messages, or what's placed from elsewhere, as an item that moves", () => {
    expect(movableOf(mailTab)).toBeNull()
    expect(movableOf(placedKey("02", { kind: "artifact", id: "hero" }))).toBeNull()
  })
})
