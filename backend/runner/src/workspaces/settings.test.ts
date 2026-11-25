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

describe("Murmur's Experimental switch", () => {
  it("is first saved on where Murmur was on, and off for everyone else", ({ resources }) => {
    const fresh = new WorkspaceStore()
    resources.defer(() => fresh.close())
    fresh.settings.carryMurmurSwitch()
    expect(fresh.settings.runner().murmur).toBe(false)

    const declined = new WorkspaceStore()
    resources.defer(() => declined.close())
    declined.settings.saveMurmurSettings({ enabled: false })
    declined.settings.carryMurmurSwitch()
    expect(declined.settings.runner().murmur).toBe(false)

    const using = new WorkspaceStore()
    resources.defer(() => using.close())
    using.settings.saveMurmurSettings({ enabled: true })
    using.settings.carryMurmurSwitch()
    expect(using.settings.runner().murmur).toBe(true)
  })

  it("is saved once: Murmur turned off later, or the switch changed, stays as it is", ({
    resources,
  }) => {
    const store = new WorkspaceStore()
    resources.defer(() => store.close())
    store.settings.saveMurmurSettings({ enabled: true })
    store.settings.carryMurmurSwitch()
    store.settings.saveMurmurSettings({ enabled: false })
    store.settings.carryMurmurSwitch()
    expect(store.settings.runner().murmur).toBe(true)

    store.settings.saveRunner({ murmur: false })
    store.settings.saveMurmurSettings({ enabled: true })
    store.settings.carryMurmurSwitch()
    expect(store.settings.runner().murmur).toBe(false)
  })
})
