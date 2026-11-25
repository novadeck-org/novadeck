import { execFileSync } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"

import { afterAll, beforeAll } from "vitest"

import { tourMarker } from "../tour/folder.js"
import { ownPi } from "./agents/own-pi.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { ownPiFromCache } from "./own-pi-cache.js"
import { seedTour } from "./tour-story.js"

// Novadeck's tour (docs/tour.md), the runner's side of it, on Novadeck's own pi alone:
// `tour.prepare` has the runner download its own pi (from the e2e cache's copy, as a mirror), gets
// a ticket from the tour's service (here a fake one at NOVADECK_TOUR_ENDPOINT, which the runner
// reads as it asks), readies its folder, and answers the line that starts Novadeck's pi there; the
// service's address and the ticket come with the shells of that folder. The story with the agents
// themselves is tour-story.e2e.ts's, which waits on a fake model that speaks the service's dialect.

// The tour's folder, as the sandbox's home holds it.
const folder = join(".novadeck", "tour")

// The fake service: tickets until it is told to refuse, as the website's would, and a log of
// what it was asked.
const asked: string[] = []
let refusal: { status: number; error: string } | undefined
let server: Server
const previous = process.env.NOVADECK_TOUR_ENDPOINT
let restorePi: (() => void) | undefined

beforeAll(async () => {
  restorePi = await ownPiFromCache()
  server = createServer((request, response) => {
    asked.push(`${request.method} ${request.url}`)
    response.setHeader("content-type", "application/json")
    if (request.url === "/tour/v1/tickets" && refusal) {
      response.statusCode = refusal.status
      response.end(JSON.stringify({ error: refusal.error }))
      return
    }
    response.end(JSON.stringify({ ticket: "e2e_ticket-1", expiresAt: "2099-01-01T00:00:00Z" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  process.env.NOVADECK_TOUR_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tour/v1`
})

afterAll(async () => {
  restorePi?.()
  if (previous === undefined) delete process.env.NOVADECK_TOUR_ENDPOINT
  else process.env.NOVADECK_TOUR_ENDPOINT = previous
  await new Promise((resolve) => server.close(resolve))
})

describe.skipIf(!supported)(ownPi.name, () => {
  const it = e2e.seeded({ trustedInHome: [folder] }, ownPi)

  it("readies the tour's folder with a ticket, and a launch line on GPT-6 Luna, with the service and ticket in its folder's shells only", async ({
    e2e: run,
  }) => {
    await seedTour(run)
    refusal = undefined
    asked.length = 0
    const prepared = await run.deck.tour.prepare()

    expect(asked).toEqual(["POST /tour/v1/tickets"])
    expect(prepared.directory).toBe(join(run.sandbox.home, folder))
    expect(prepared.removed).toEqual([])
    // No prompt on the line: its brief is rung to it once it is up.
    expect(prepared.brief).toBe("doorbell")
    expect(prepared.model).toBe("novadeck/gpt-6-luna")
    // Novadeck's own pi by its word, which the shell turns into its launcher: no flag for edits.
    expect(prepared.command).toBe("novadeck-pi --model novadeck/gpt-6-luna --thinking medium")
    expect(typeof prepared.page).toBe("boolean")
    // The service and ticket come with the shells of its folder once it is a project, and no
    // other's; nothing of opencode's.
    await run.deck.openAt(prepared.directory, prepared.command)
    const env = run.deck.tour.launchEnv(prepared.directory)
    expect(env).toEqual({
      NOVADECK_PI_BASE_URL: process.env.NOVADECK_TOUR_ENDPOINT,
      NOVADECK_PI_KEY: "e2e_ticket-1",
    })
    expect(run.deck.tour.launchEnv(run.sandbox.home)).toBeUndefined()
    // The folder's own files hold no script, and no ticket: it reaches the lead as a notice.
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      // eslint-disable-next-line no-await-in-loop -- Two small files.
      const loaded = await readFile(join(prepared.directory, name), "utf8")
      expect(loaded).not.toMatch(/open_agent|describe|Steps|lead agent|e2e_ticket/)
    }
    // The seed game, in a tiny git repo on main with one commit by the tour's own name.
    const gitIn = (...args: string[]) =>
      execFileSync("git", ["-C", prepared.directory, ...args], { encoding: "utf8" }).trim()
    expect(gitIn("branch", "--show-current")).toBe("main")
    expect(gitIn("log", "--format=%an <%ae>")).toBe("Novadeck tour <tour@novadeck.invalid>")
    expect(gitIn("status", "--porcelain")).toBe("")
    await expect(readFile(join(prepared.directory, tourMarker), "utf8")).resolves.toContain(
      "Novadeck's tour",
    )
  })

  it("shows the service's refusal as it words it, leaving the folder as it is", async ({
    e2e: run,
  }) => {
    await seedTour(run)
    refusal = undefined
    const { directory } = await run.deck.tour.prepare()
    refusal = { status: 429, error: "You've taken today's free tours." }
    await expect(run.deck.tour.prepare()).rejects.toMatchObject({
      code: "CONFLICT",
      message: "You've taken today's free tours.",
    })
    refusal = { status: 503, error: "The free tour is off for now." }
    await expect(run.deck.tour.prepare()).rejects.toThrow("The free tour is off for now.")
    refusal = undefined
    expect(await readdir(directory)).toContain(tourMarker)
  })

  it("removes the first run's project and closes its terminal when the tour starts again", async ({
    e2e: run,
  }) => {
    await seedTour(run)
    refusal = undefined
    const first = await run.deck.tour.prepare()
    const opened = await run.deck.openAt(first.directory, first.command)
    const project = run.deck.store.projects().find(({ cwd }) => cwd === first.directory)
    expect(project).toBeDefined()

    const second = await run.deck.tour.prepare()

    expect(second.removed).toEqual([project!.id])
    expect(run.deck.store.projects().some(({ id }) => id === project!.id)).toBe(false)
    expect(() => run.deck.terminals.get(opened.id)).toThrow(
      expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
    )
  })

  it("leaves a kept project to the person, and takes the next folder for the next run", async ({
    e2e: run,
  }) => {
    await seedTour(run)
    refusal = undefined
    const first = await run.deck.tour.prepare()
    await run.deck.tour.keep()
    await expect(readdir(first.directory)).resolves.not.toContain(tourMarker)
    const second = await run.deck.tour.prepare()
    expect(second.directory).toBe(join(run.sandbox.home, ".novadeck", "tour-2"))
  })
})
