import { describe, expect, it } from "../test.js"
import { WorkspaceStore } from "./store.js"

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
