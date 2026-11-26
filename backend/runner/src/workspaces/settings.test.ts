import { describe, expect, it } from "../test.js"
import { WorkspaceStore } from "./store.js"

describe("Murmur's Experimental switch", () => {
  it("is first saved on where Murmur was on or its files are, and off for everyone else", ({
    resources,
  }) => {
    const fresh = new WorkspaceStore()
    resources.defer(() => fresh.close())
    fresh.settings.carryMurmurSwitch(false)
    expect(fresh.settings.runner().murmur).toBe(false)

    const declined = new WorkspaceStore()
    resources.defer(() => declined.close())
    declined.settings.saveMurmurSettings({ enabled: false })
    declined.settings.carryMurmurSwitch(false)
    expect(declined.settings.runner().murmur).toBe(false)

    const using = new WorkspaceStore()
    resources.defer(() => using.close())
    using.settings.saveMurmurSettings({ enabled: true })
    using.settings.carryMurmurSwitch(false)
    expect(using.settings.runner().murmur).toBe(true)

    // Installed, then turned off: on, so Addons keeps the files' Uninstall.
    const installed = new WorkspaceStore()
    resources.defer(() => installed.close())
    installed.settings.saveMurmurSettings({ enabled: false })
    installed.settings.carryMurmurSwitch(true)
    expect(installed.settings.runner().murmur).toBe(true)
  })

  it("is saved once: Murmur turned off later, or the switch changed, stays as it is", ({
    resources,
  }) => {
    const store = new WorkspaceStore()
    resources.defer(() => store.close())
    store.settings.saveMurmurSettings({ enabled: true })
    store.settings.carryMurmurSwitch(false)
    store.settings.saveMurmurSettings({ enabled: false })
    store.settings.carryMurmurSwitch(false)
    expect(store.settings.runner().murmur).toBe(true)

    store.settings.saveRunner({ murmur: false })
    store.settings.saveMurmurSettings({ enabled: true })
    store.settings.carryMurmurSwitch(false)
    expect(store.settings.runner().murmur).toBe(false)
  })
})

describe("the agent worktrees switch", () => {
  it("reads on until the person turns it off", ({ resources }) => {
    const store = new WorkspaceStore()
    resources.defer(() => store.close())
    expect(store.settings.runner().worktrees).toBe(true)
    store.settings.saveRunner({ worktrees: false })
    expect(store.settings.runner().worktrees).toBe(false)
    store.settings.saveRunner({ worktrees: true })
    expect(store.settings.runner().worktrees).toBe(true)
  })

  it("is carried on once, as a stable build saved it off at every launch while Experimental", ({
    resources,
  }) => {
    const stable = new WorkspaceStore()
    resources.defer(() => stable.close())
    stable.settings.saveRunner({ worktrees: false })
    stable.settings.carryWorktreesSwitch()
    expect(stable.settings.runner().worktrees).toBe(true)

    const experimental = new WorkspaceStore()
    resources.defer(() => experimental.close())
    experimental.settings.saveRunner({ worktrees: true })
    experimental.settings.carryWorktreesSwitch()
    expect(experimental.settings.runner().worktrees).toBe(true)
  })

  it("keeps an off the person chooses after the carry, across launches", ({ resources }) => {
    const store = new WorkspaceStore()
    resources.defer(() => store.close())
    store.settings.carryWorktreesSwitch()
    store.settings.saveRunner({ worktrees: false })
    store.settings.carryWorktreesSwitch()
    expect(store.settings.runner().worktrees).toBe(false)
  })
})
