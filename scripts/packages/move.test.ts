import { describe, expect, it } from "vitest"

import { applyEdit, isText, keeps, type Edit } from "./move.ts"

describe("an edit by hand", () => {
  const edit: Edit = {
    file: "f",
    before: "../relay/dist",
    after: "../../backend/relay/dist",
    why: "w",
  }

  it("is made once, and a second run finds it there", () => {
    expect(applyEdit("from: ../relay/dist\n", edit)).toEqual({
      text: "from: ../../backend/relay/dist\n",
      state: "made",
    })
    expect(applyEdit("from: ../../backend/relay/dist\n", edit)).toEqual({
      text: "from: ../../backend/relay/dist\n",
      state: "there",
    })
  })

  it("has nothing to do, and says so, once a person changed the line", () => {
    expect(applyEdit("from: elsewhere\n", edit)).toEqual({
      text: "from: elsewhere\n",
      state: "gone",
    })
  })

  it("stops the run where the old text is there twice, unless it's meant everywhere", () => {
    expect(applyEdit("../relay/dist ../relay/dist", edit)).toHaveProperty("problem")
    expect(applyEdit("../relay/dist ../relay/dist", { ...edit, all: true })).toEqual({
      text: "../../backend/relay/dist ../../backend/relay/dist",
      state: "made",
    })
  })
})

describe("which files a move reads", () => {
  it("reads text, by its extension or its name", () => {
    expect(isText("a/b.ts")).toBe(true)
    expect(isText(".github/workflows/e2e.yml")).toBe(true)
    expect(isText("backend/relay/src/main.rs")).toBe(true)
    expect(isText(".gitattributes")).toBe(true)
    expect(isText("application/ui/public/icon.png")).toBe(false)
  })

  it("keeps a listed file, or anything under a listed folder", () => {
    const kept = [
      { path: "pnpm-lock.yaml", why: "" },
      { path: "scripts/flakes/fixtures/", why: "" },
    ]
    expect(keeps(kept, "pnpm-lock.yaml")).toBe(true)
    expect(keeps(kept, "scripts/flakes/fixtures/a.txt")).toBe(true)
    expect(keeps(kept, "scripts/flakes/match.ts")).toBe(false)
  })
})
