import { describe, expect, it } from "vitest"

import { done, hints, noticed, openedMarked, type Seen, type Signals } from "./visitor-hints"

const quiet: Signals = {
  answered: false,
  view: "focus",
  companion: false,
  marked: false,
}
const hint = (id: string) => hints.find((each) => each.id === id)!

describe("the visitor's things to try", () => {
  it("notices nothing while the person has done nothing", () => {
    expect(noticed(new Set(), quiet).size).toBe(0)
  })

  it("keeps what was seen after it no longer shows", () => {
    const seen = noticed(new Set(), { ...quiet, view: "grid" })

    expect(noticed(seen, quiet).has("grid")).toBe(true)
  })

  it("is done with the views only once both Grid and Canvas were seen", () => {
    const grid = noticed(new Set(), { ...quiet, view: "grid" })
    const both = noticed(grid, { ...quiet, view: "canvas" })

    expect(done(hint("views"), grid)).toBe(false)
    expect(done(hint("views"), both)).toBe(true)
  })

  it("sees an answer, an open pane and a marked project opened", () => {
    const seen: ReadonlySet<Seen> = noticed(new Set(), {
      answered: true,
      view: "focus",
      companion: true,
      marked: true,
    })

    expect(["answer", "companion", "project"].every((id) => done(hint(id), seen))).toBe(true)
  })

  it("does not tick the answer or the project hint for anything else", () => {
    const seen = noticed(new Set(), { ...quiet, view: "grid", companion: true })

    expect(done(hint("answer"), seen)).toBe(false)
    expect(done(hint("project"), seen)).toBe(false)
  })

  describe("a project opened", () => {
    const statuses = {
      infra: "failed",
      "docs-site": "done",
      "mobile-app": "attention",
      api: "running",
    } as const

    it("counts when the switcher marked it as it was opened", () => {
      for (const project of ["infra", "docs-site", "mobile-app"])
        expect(openedMarked(statuses, "storefront", project)).toBe(true)
    })

    it("does not count when it had no mark, or only showed work going on", () => {
      expect(openedMarked(statuses, "storefront", "design-system")).toBe(false)
      expect(openedMarked(statuses, "storefront", "api")).toBe(false)
    })

    it("does not count while the person stays in a marked project", () => {
      expect(openedMarked(statuses, "infra", "infra")).toBe(false)
    })
  })
})
