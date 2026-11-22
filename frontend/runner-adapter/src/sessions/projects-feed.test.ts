import type { BackendAction } from "@novadeck/core/port"
import { workspaceFixture } from "@novadeck/core/testing"
import type { Workspace } from "@novadeck/core/types"
import type { ProjectsChange } from "@novadeck/protocol"
import type { Runner } from "@novadeck/runner-client"

import { context, describe, expect, it } from "../test"
import { channel } from "../testing/channel"
import { followProjects } from "./projects-feed"

// Two projects here, both on the runner as this client loaded.
const workspace = (): Workspace => {
  const one = workspaceFixture()
  return {
    ...one,
    projects: [...one.projects, { ...one.projects[0]!, id: "other", name: "Other" }],
  }
}
const listed = (...ids: string[]): ProjectsChange => ({
  type: "projects",
  projects: ids.map((id) => ({
    id,
    name: id === "other" ? "Other" : "Project",
    cwd: "/",
    pinned: false,
  })),
})

const follow = (holding: () => boolean, removedHere: (id: string) => boolean = () => false) => {
  const feed = channel<ProjectsChange>()
  const dispatched: BackendAction[] = []
  const live = followProjects({
    runner: {
      supports: () => true,
      projects: { watch: () => feed.iterator },
    } as unknown as Pick<Runner, "projects" | "supports">,
    latest: workspace,
    dispatch: (actions) => dispatched.push(...actions),
    now: () => 1,
    read: async () => undefined,
    removedHere,
    holding,
    arranged: () => {},
    listed: ["project", "other"],
  })
  const lists = async (change: ProjectsChange) => {
    feed.push(change)
    await new Promise((done) => setTimeout(done, 0))
  }
  return { live, lists, dispatched }
}

describe("projects another client removed", () => {
  it("go here", async () => {
    const { lists, dispatched } = follow(() => false)
    await lists(listed("project"))
    expect(dispatched).toEqual([{ type: "project/gone", projectId: "other", now: 1 }])
  })

  // Starting the tour removes the tours before on the runner, which this client then removes
  // itself as it opens the new one.
  context("while a tour this client starts is being readied", () => {
    it("are held, and those the run removed are this client's own", async () => {
      let holding = true
      const own = new Set<string>()
      const { live, lists, dispatched } = follow(
        () => holding,
        (id) => own.has(id),
      )
      await lists(listed("project"))
      expect(dispatched).toEqual([])
      holding = false
      own.add("other")
      live.released()
      expect(dispatched).toEqual([])
    })

    it("go once it's ready when the run didn't remove them", async () => {
      let holding = true
      const { live, lists, dispatched } = follow(() => holding)
      await lists(listed("project"))
      holding = false
      live.released()
      expect(dispatched).toEqual([{ type: "project/gone", projectId: "other", now: 1 }])
    })
  })
})
