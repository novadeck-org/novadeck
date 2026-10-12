import { describe, expect, it } from "../../../test"
import { createDemoPortable, portableVersion, releaseOffer } from "./portable"

describe("demo portable copy", () => {
  it("says it is portable, and ends every install as armed", async () => {
    const { portable } = createDemoPortable({
      install: { kind: "newer", version: "0.0.99" },
    })
    expect(await portable.state()).toEqual({
      portable: true,
      version: portableVersion,
    })
    expect(await portable.install()).toEqual({
      kind: "newer",
      version: "0.0.99",
    })
  })

  it("counts the presses of Open Novadeck", () => {
    const { portable, opened } = createDemoPortable({
      install: { kind: "installing" },
    })
    portable.openInstalled()
    expect(opened()).toBe(1)
  })

  it("dates a release the given days back", () => {
    const { outdatedSince } = releaseOffer("0.0.80", 20)
    const days = (Date.now() - Date.parse(outdatedSince!)) / (24 * 60 * 60 * 1000)
    expect(Math.round(days)).toBe(20)
  })
})
