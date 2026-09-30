import type { ArtifactRef } from "../../model/companion"
import { context, describe, expect, it } from "../../test"
import {
  dismiss,
  freshCount,
  openCompanion,
  pickFromGroup,
  planTab,
  selectTab,
  show,
  slotsOf,
  type Companion,
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
const companion: Companion = { open: false, tab: root, home: root, artifacts: [] }

describe("companion pane", () => {
  context("when the agent shows something", () => {
    const shown = show(companion, home, false)

    it("waits, marked new, without opening", () => {
      expect(shown.open).toBe(false)
      expect(shown.tab).toBe(root)
      expect(freshCount(shown)).toBe(1)
    })

    it("lists each thing once", () => {
      expect(show(shown, home, false).artifacts).toHaveLength(1)
    })

    it("opens to what's new when no tab is chosen", () => {
      const opened = openCompanion(show(shown, preview, false))
      expect(opened.open).toBe(true)
      expect(opened.tab).toBe(preview.id)
      expect(freshCount(opened)).toBe(1)
    })
  })

  context("when the user asked for it", () => {
    it("opens straight to it, not new", () => {
      const shown = show(companion, home, true)
      expect(shown).toMatchObject({ open: true, tab: home.id })
      expect(freshCount(shown)).toBe(0)
    })
  })

  context("when a tab is looked at", () => {
    it("is no longer new", () => {
      expect(freshCount(selectTab(show(companion, home, false), home.id))).toBe(0)
    })
  })

  context("when the user dismisses something", () => {
    it("leaves the pane, which falls back to the plan if it was showing it", () => {
      const dismissed = dismiss(show(companion, home, true), home.id)
      expect(dismissed.artifacts).toEqual([])
      expect(dismissed.tab).toBe(root)
    })
  })

  context("when the taskbar lays out its slots", () => {
    it("gives a lone image its own slot", () => {
      const shown = show(show(companion, image("hero"), false), home, false)
      expect(slotsOf(shown.artifacts).map((slot) => slot.kind)).toEqual(["one", "one"])
    })

    it("groups several images where the first one arrived", () => {
      let shown = show(companion, image("hero"), false)
      for (const next of [home, image("about"), preview]) shown = show(shown, next, false)
      const slots = slotsOf(shown.artifacts)
      expect(slots.map((slot) => slot.kind)).toEqual(["images", "one", "one"])
      expect(slots[0]).toMatchObject({ artifacts: [{ id: "hero" }, { id: "about" }] })
    })

    it("opens a group to what's new, else what's open, else the latest", () => {
      const two = show(show(companion, image("a"), false), image("b"), false)
      expect(pickFromGroup(two, two.artifacts).id).toBe("b")
      const read = selectTab(selectTab(two, "b"), "a")
      expect(pickFromGroup(read, read.artifacts).id).toBe("a")
      expect(pickFromGroup({ ...read, tab: root }, read.artifacts).id).toBe("b")
    })
  })

  context("when the agent shows something again", () => {
    it("takes its new version in place, new again", () => {
      const seen = selectTab(show(companion, home, false), home.id)
      const again = show(seen, { ...home, version: 2, detail: "lines 1–5" }, false)
      expect(again.artifacts).toMatchObject([
        { id: "home", version: 2, detail: "lines 1–5", fresh: true },
      ])
    })
  })

  describe("when it was shown before this session", () => {
    it("is listed as already seen, and opens nothing even if asked for", () => {
      const listed = show(companion, home, true, true)
      expect(listed).toMatchObject({ open: false, artifacts: [{ id: "home", fresh: false }] })
      expect(listed.tab).toBe(companion.tab)
    })
  })
})
