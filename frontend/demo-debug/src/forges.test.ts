import type { Workspace } from "@novadeck/core/types"
import { plainDemo } from "@novadeck/demo"
import { createDemoForges } from "@novadeck/demo/forges"
import { storefrontPlans } from "@novadeck/demo/work-plans"
import { createDemoWorks, worksFromPlans } from "@novadeck/demo/works"

import type { DemoLaunch } from "./debug-demo"
import { forgesGroups } from "./forges"
import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"

const seed = plainDemo("plain").seed
const session = seed.projects[0]!.sessions[0]!
const workspace = {
  projects: [
    {
      id: "storefront",
      history: [{ id: session.id, state: { roster: { terminals: session.terminals } } }],
    },
  ],
} as unknown as Workspace
const key = (slot: number) => ({
  projectId: "storefront",
  workspaceSessionId: session.id,
  terminalId: session.terminals[slot]!.id,
})

const setup = () => {
  const forges = createDemoForges()
  const works = createDemoWorks(worksFromPlans(seed, storefrontPlans, 0))
  const booted: boolean[] = []
  const launch = { setForges: (offered: boolean) => booted.push(offered) } as unknown as DemoLaunch
  const [group] = forgesGroups(launch, { forges, works })
  const run = (label: string, selected = 0) =>
    void group!.actions
      .find((action) => action.label === label)!
      .run({
        selected: () => key(selected),
        workspace: () => workspace,
        note: () => {},
      } as unknown as DemoActionContext)
  return { forges, works, group: group!, run, booted }
}

describe("the debug panel's Forges group", () => {
  it("is in the App section, and every action names what appears", () => {
    const { group } = setup()
    expect(group.section).toBe("App")
    expect(group.actions.length).toBeGreaterThan(10)
    for (const action of group.actions) expect(action.hint.length).toBeGreaterThan(20)
    expect(group.actions.filter((action) => action.reboots).map((action) => action.label)).toEqual([
      "Offered, experimental channel",
      "Not offered",
    ])
  })

  it("moves the forges between the states Preferences shows", () => {
    const { forges, run } = setup()
    run("All signed out")
    expect(
      forges.state.getSnapshot().flatMap((each) => each.hosts.map((host) => host.state)),
    ).toEqual(["signed-out", "signed-out", "signed-out"])
    run("CLI missing")
    expect(forges.state.getSnapshot().every((each) => !each.available)).toBe(true)
  })

  it("boots with forges offered or not", () => {
    const { run, booted } = setup()
    run("Not offered")
    run("Offered, experimental channel")
    expect(booted).toEqual([false, true])
  })

  it("sets the pull request on the selected terminal's work, and takes it away", () => {
    const { works, run } = setup()
    const first = works.state.getSnapshot().works[0]!
    const slot = session.terminals.findIndex((terminal) => terminal.id === first.terminalId)
    const owned = () => works.ownedBy(first.terminalId!)
    run("Pull request: merged", slot)
    expect(owned()?.pullRequest).toMatchObject({ state: "merged" })
    run("Pull request: draft", slot)
    expect(owned()?.pullRequest?.state).toBe("draft")
    run("No pull request", slot)
    expect(owned()?.pullRequest).toBeUndefined()
  })

  it("sets how the pull request's checks stand, making an open one where there was none", () => {
    const { works, run } = setup()
    const first = works.state.getSnapshot().works[0]!
    const slot = session.terminals.findIndex((terminal) => terminal.id === first.terminalId)
    const pull = () => works.ownedBy(first.terminalId!)?.pullRequest
    run("CI failing", slot)
    expect(pull()?.ci).toBe("failing")
    run("CI running", slot)
    expect(pull()?.ci).toBe("running")
    run("CI passed", slot)
    expect(pull()?.ci).toBe("passed")
    run("No CI", slot)
    expect(pull()?.ci).toBe("none")
    run("No pull request", slot)
    run("CI failing", slot)
    expect(pull()).toMatchObject({ number: 812, state: "open", ci: "failing" })
    // A pull request that is done has no checks to show.
    run("Pull request: closed", slot)
    expect(pull()).not.toHaveProperty("ci")
  })

  it("falls back to the project's first work for a terminal with none", () => {
    const { works, run } = setup()
    const withWork = new Set(works.state.getSnapshot().works.map((work) => work.terminalId))
    const slot = session.terminals.findIndex((terminal) => !withWork.has(terminal.id))
    run("Pull request: closed", slot)
    expect(works.worksOf("storefront")[0]?.pullRequest?.state).toBe("closed")
  })

  it("is empty of forge states where the backend's are not the demo's", () => {
    const [group] = forgesGroups({} as DemoLaunch, {})
    expect(group!.actions.map((action) => action.label)).toEqual([
      "Offered, experimental channel",
      "Not offered",
    ])
  })
})
