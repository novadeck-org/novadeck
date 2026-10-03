import type { Runner } from "@novadeck/protocol/client"
import { afterAll, vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { loadListing } from "./index"
import { startTestRunner } from "./testing"

vi.setConfig({ testTimeout: 10_000 })

const runner = await startTestRunner()
afterAll(() => runner.close())

const newId = () => crypto.randomUUID()

// The runner's client, but another window removes `removed` just after the projects are
// listed and before anything is asked about them.
const removingAfterList = (removed: () => readonly string[]): Runner => ({
  ...runner.client,
  projects: {
    ...runner.client.projects,
    list: async () => {
      const listed = await runner.client.projects.list()
      await Promise.all(removed().map((projectId) => runner.client.projects.remove({ projectId })))
      return listed
    },
  },
})

// A project on the runner, with a first session unless `bare`.
const projectOnRunner = async (bare = false) => {
  const project = await runner.client.projects.create({
    id: newId(),
    name: "Listed",
    cwd: process.cwd(),
  })
  if (!bare)
    await runner.client.sessions.create({ id: newId(), projectId: project.id, name: "First" })
  return project.id
}

describe("loading the runner's listing", () => {
  context("when a project is removed while the listing loads", () => {
    it("leaves out one with sessions and lists the others", async () => {
      const removed = await projectOnRunner()
      const kept = await projectOnRunner()
      const listing = await loadListing(
        removingAfterList(() => [removed]),
        newId,
        Date.now,
      )
      const ids = listing.map((item) => item.project.id)
      expect(ids).toContain(kept)
      expect(ids).not.toContain(removed)
    })

    it("leaves out one without sessions, rather than give it a first one", async () => {
      const removed = await projectOnRunner(true)
      const listing = await loadListing(
        removingAfterList(() => [removed]),
        newId,
        Date.now,
      )
      expect(listing.map((item) => item.project.id)).not.toContain(removed)
      await expect(runner.client.sessions.list({ projectId: removed })).rejects.toMatchObject({
        code: "NOT_FOUND",
      })
    })

    it("opens a fresh Home project with a session when every project went", async () => {
      const all = (await runner.client.projects.list()).map((project) => project.id)
      const listing = await loadListing(
        removingAfterList(() => all),
        newId,
        Date.now,
      )
      expect(listing).toEqual([
        expect.objectContaining({
          project: expect.objectContaining({ name: "Home" }),
          sessions: [expect.objectContaining({ terminals: [] })],
        }),
      ])
      expect(all).not.toContain(listing[0]!.project.id)
    })
  })
})
