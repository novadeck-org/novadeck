import type { ForgeConnection, Forges } from "@novadeck/core/forges"
import { createStore } from "@novadeck/core/store"
import type { Works, WorksState } from "@novadeck/core/works"
import { describe, expect, it } from "vitest"

import { pullRequestsOf } from "./pull-requests"

const forge = (enabled: boolean): ForgeConnection => ({
  forge: "github",
  available: true,
  enabled,
  busy: false,
  hosts: [],
})

// Works that count who follows them, and forges switched as `enabled` says.
const setup = (enabled: boolean) => {
  const watching = { now: 0, ever: 0 }
  const works: Works = {
    state: createStore<WorksState>({ works: [], synced: true, reported: true }),
    watch: () => {
      watching.now += 1
      watching.ever += 1
      return () => {
        watching.now -= 1
      }
    },
    look: () => {},
    show: async () => null,
    close: async () => ({ closed: true, branchDeleted: false }),
    preview: async () => ({ main: null, works: [], renames: [] }),
  }
  const switches = createStore<readonly ForgeConnection[]>([forge(enabled)])
  const forges: Forges = { state: switches, set: () => {}, refresh: async () => {} }
  const turn = (on: boolean) => switches.update(() => [forge(on)])
  return { works, forges, watching, turn }
}

describe("the pull requests a changes item reads", () => {
  it("are the works' own", () => {
    const { works, forges } = setup(true)
    expect(pullRequestsOf({ works, forges })?.state).toBe(works.state)
  })

  it("are looked for while a forge is switched on", () => {
    const { works, forges, turn } = setup(false)
    const { on } = pullRequestsOf({ works, forges })!
    const seen: boolean[] = []
    on.subscribe(() => seen.push(on.getSnapshot()))
    expect(on.getSnapshot()).toBe(false)
    turn(true)
    turn(false)
    expect(seen).toEqual([true, false])
  })

  it("are what the works say where the backend has no forges", () => {
    const { works } = setup(false)
    expect(pullRequestsOf({ works })!.on.getSnapshot()).toBe(true)
  })

  it("are none where the backend has no works", () => {
    expect(pullRequestsOf({})).toBeUndefined()
  })

  it("follow the works only while a forge is switched on", () => {
    const { works, forges, watching, turn } = setup(false)
    const release = pullRequestsOf({ works, forges })!.follow()
    expect(watching.now).toBe(0)
    turn(true)
    expect(watching.now).toBe(1)
    turn(true)
    expect(watching).toEqual({ now: 1, ever: 1 })
    turn(false)
    expect(watching.now).toBe(0)
    turn(true)
    release()
    expect(watching).toEqual({ now: 0, ever: 2 })
    // Let go, a forge switched on no longer follows them.
    turn(false)
    turn(true)
    expect(watching.ever).toBe(2)
  })

  it("follow nothing where the backend has no forges", () => {
    const { works, watching } = setup(true)
    pullRequestsOf({ works })!.follow()()
    expect(watching.ever).toBe(0)
  })
})
