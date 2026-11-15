import { describe, expect, it } from "../test.js"
import { WorkspaceStore } from "./store.js"

describe("the forges setting", () => {
  it("reads as none until a forge is switched on, and keeps the ones that are", ({ resources }) => {
    const store = new WorkspaceStore()
    resources.defer(() => store.close())
    expect(store.settings.forges()).toEqual([])
    store.settings.saveForges(["azure", "github"])
    expect(store.settings.forges()).toEqual(["github", "azure"])
    store.settings.saveForges([])
    expect(store.settings.forges()).toEqual([])
  })

  it("keeps the known forges of a list a newer build wrote more names in", ({ resources }) => {
    const store = new WorkspaceStore()
    resources.defer(() => store.close())
    store.settings["saveSettingJson"]("forges", ["bitbucket", "gitlab", 3])
    expect(store.settings.forges()).toEqual(["gitlab"])
  })

  it("is no part of the runner's settings", ({ resources }) => {
    const store = new WorkspaceStore()
    resources.defer(() => store.close())
    store.settings.saveForges(["gitlab"])
    expect(store.settings.runner()).not.toHaveProperty("forges")
  })
})
