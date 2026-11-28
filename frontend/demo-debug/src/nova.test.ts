import { createDemoNova } from "@novadeck/demo/nova"

import { novaGroups } from "./nova"
import { describe, expect, it } from "./test"

describe("the Nova group", () => {
  it("puts the row in each of its states", () => {
    const pi = createDemoNova()
    const [group] = novaGroups({ nova: pi })
    const run = (label: string) =>
      group?.actions.find((action) => action.label === label)?.run({} as never)
    run("Failed")
    expect(pi.enabled.getSnapshot()).toBe(true)
    expect(pi.fetch.getSnapshot()).toMatchObject({ state: "failed" })
    run("Downloading")
    expect(pi.fetch.getSnapshot()).toMatchObject({ state: "downloading", received: 12_345_678 })
    run("Ready")
    expect(pi.fetch.getSnapshot()).toEqual({ state: "ready" })
    run("Off")
    expect(pi.enabled.getSnapshot()).toBe(false)
  })

  it("has none where the backend's isn't the demo's", () => {
    expect(novaGroups({})).toEqual([])
  })
})
