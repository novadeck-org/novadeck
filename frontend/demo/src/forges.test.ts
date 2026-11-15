import { forgeNames } from "@novadeck/core/forges"

import {
  createDemoForges,
  demoForgeInstallers,
  demoRefresh,
  demoSignIn,
  scenarioOf,
} from "./forges"
import { describe, expect, it } from "./test"

const entry = (forges: ReturnType<typeof createDemoForges>, name: string) =>
  forges.state.getSnapshot().find((each) => each.forge === name)!

describe("the demo's forges", () => {
  it("start with GitHub signed in, GitLab signed out and Azure DevOps not installed", () => {
    const forges = createDemoForges()
    expect(entry(forges, "github")).toMatchObject({
      available: true,
      enabled: true,
      hosts: [{ host: "github.com", state: "signed-in" }],
    })
    expect(entry(forges, "gitlab").hosts).toEqual([
      { host: "gitlab.com", state: "signed-out", fix: demoSignIn.gitlab },
    ])
    expect(entry(forges, "azure")).toMatchObject({
      available: false,
      enabled: false,
      installer: demoForgeInstallers.azure,
    })
  })

  it("reach every state the rows can be in", () => {
    const hostStates = (name: Parameters<typeof scenarioOf>[0]) =>
      scenarioOf(name).flatMap((each) => each.hosts.map((host) => host.state))
    expect(hostStates("signed-in")).toEqual(["signed-in", "signed-in", "signed-in"])
    expect(hostStates("signed-out")).toEqual(["signed-out", "signed-out", "signed-out"])
    expect(hostStates("refused")).toEqual(["refused", "refused", "refused"])
    expect(scenarioOf("missing").map((each) => each.available)).toEqual([false, false, false])
    // GitHub has no installer on its own, which reads as "Needs gh".
    expect(scenarioOf("missing").map((each) => each.installer)).toEqual([
      undefined,
      demoForgeInstallers.gitlab,
      demoForgeInstallers.azure,
    ])
    expect(scenarioOf("busy")[0]!.busy).toBe(true)
    expect(scenarioOf("refused-unmendable").map((each) => each.hosts[0]?.fix)).toEqual([
      demoRefresh.github,
      undefined,
      undefined,
    ])
    expect(scenarioOf("several-hosts")[0]!.hosts.map((each) => each.state)).toEqual([
      "signed-in",
      "signed-out",
    ])
    expect(
      scenarioOf("on-but-missing").map((each) => [each.enabled, each.available, each.hosts]),
    ).toEqual([
      [true, false, []],
      [true, false, []],
      [true, false, []],
    ])
    expect(scenarioOf("error")[0]!.error).toBeDefined()
    expect(scenarioOf("start").map((each) => each.forge)).toEqual([...forgeNames])
  })

  it("switch on and off, keeping what they found", () => {
    const forges = createDemoForges()
    forges.set("github", false)
    expect(entry(forges, "github")).toMatchObject({ enabled: false })
    forges.set("github", true)
    expect(entry(forges, "github").hosts[0]!.state).toBe("signed-in")
  })

  it("sign a host in once its sign-in terminal ends well, and not where it fails", () => {
    const forges = createDemoForges()
    const play = forges.played(demoSignIn.gitlab)!
    expect(play).toMatchObject({ kind: "sign-in", forge: "gitlab" })
    play.end("failed")
    expect(entry(forges, "gitlab").hosts[0]!.state).toBe("signed-out")
    play.end("done")
    expect(entry(forges, "gitlab").hosts[0]!.state).toBe("signed-in")
  })

  it("make a forge available once its installer ends well, signed out", () => {
    const forges = createDemoForges()
    forges.played(demoForgeInstallers.azure)!.end("done")
    const azure = entry(forges, "azure")
    expect(azure.available).toBe(true)
    expect(azure).not.toHaveProperty("installer")
    expect(azure.hosts[0]!.state).toBe("signed-out")
  })

  it("play no other command", () => {
    expect(createDemoForges().played("ls")).toBeUndefined()
    expect(createDemoForges().played(undefined)).toBeUndefined()
  })
})
