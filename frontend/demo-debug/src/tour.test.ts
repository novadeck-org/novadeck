import { demoTour } from "@novadeck/demo/tour"
import { demoTourRefusal } from "@novadeck/demo/tour-runs"

import { describe, expect, it } from "./test"
import { tourGroups } from "./tour"

const tourOf = () => demoTour(() => undefined)

const runner = (tour: ReturnType<typeof tourOf>) => {
  const [group] = tourGroups(tour)
  return (label: string) => {
    const action = group!.actions.find((each) => each.label === label)
    if (!action) throw new Error(`No action ${label}`)
    void action.run({} as never)
  }
}

describe("the tour group", () => {
  it("fails only the next start, as a folder of the person's own does", async () => {
    const tour = tourOf()
    runner(tour)("Fail next start")
    await expect(tour.prepare()).rejects.toThrow(demoTourRefusal)
    await expect(tour.prepare()).resolves.toMatchObject({
      directory: "~/.novadeck/tour",
      brief: "doorbell",
      model: "nova/gpt-6-luna",
      page: true,
    })
  })

  it("puts Nova in each state for the consent, and waits for it before a start", async () => {
    const tour = tourOf()
    const run = runner(tour)
    expect(tour.agent.getSnapshot()).toEqual({ state: "ready" })
    run("Tour Pi: downloading")
    expect(tour.agent.getSnapshot()).toEqual({
      state: "downloading",
      received: 12_345_678,
      size: 58_977_130,
    })
    run("Tour Pi: downloading, size unknown")
    expect(tour.agent.getSnapshot()).toEqual({ state: "downloading" })
    run("Tour Pi: not asked for")
    expect(tour.agent.getSnapshot()).toEqual({ state: "off" })
    run("Tour Pi: failed")
    expect(tour.agent.getSnapshot()).toMatchObject({ state: "failed" })
    await expect(tour.prepare()).rejects.toThrow("github.com")
    run("Tour Pi: ready")
    expect(tour.agent.getSnapshot()).toEqual({ state: "ready" })
    await expect(tour.prepare()).resolves.toMatchObject({ directory: "~/.novadeck/tour" })
  })

  it("fails the next start as Nova's model service with no free ticket left does, with its sentence", async () => {
    const tour = tourOf()
    runner(tour)("Next start: no free ticket left")
    await expect(tour.prepare()).rejects.toThrow("free Nova tickets")
    await expect(tour.prepare()).resolves.toMatchObject({ directory: "~/.novadeck/tour" })
  })

  it("holds the next tour agent at a screen, answers it, and has it go quiet", () => {
    const tour = tourOf()
    const run = runner(tour)
    run("Tour agent: hold at sign-in")
    expect(tour.take()).toEqual({ screen: "sign-in", quiet: false })
    run("Tour agent: hold at folder trust")
    expect(tour.take().screen).toBe("startup")
    run("Tour agent: hold at hooks")
    run("Tour agent: quiet until nudged")
    expect(tour.take()).toEqual({ screen: "hooks", quiet: true })
    expect(tour.take()).toEqual({ quiet: false })
    let answered = 0
    tour.answered(() => (answered += 1))
    run("Answer the startup screen")
    expect(answered).toBe(1)
  })

  it("gives each action a hint that says what appears", () => {
    const [group] = tourGroups(tourOf())
    for (const action of group!.actions) expect(action.hint.length).toBeGreaterThan(40)
  })
})

describe("the tour the debug panel shares with the demo", () => {
  it("answers the projects open at the tour's folder, in the workspace it follows, as removed", async () => {
    const tour = demoTour(() => undefined)
    await expect(tour.prepare()).resolves.toMatchObject({ removed: [] })
    tour.follow(
      () =>
        ({
          projects: [{ id: "p1", directory: "~/.novadeck/tour" }],
        }) as never,
    )
    await expect(tour.prepare()).resolves.toMatchObject({ removed: ["p1"] })
  })

  it("drives the story: answers the pitch and World's question, quiets the team and Core", () => {
    const tour = tourOf()
    const run = runner(tour)
    const sheets: unknown[] = []
    const mates: (number | string)[] = []
    const stopped: string[] = []
    tour.sheet((answer) => sheets.push(answer))
    tour.mate((answer) => mates.push(answer))
    tour.stopped(() => stopped.push("stop"))
    run("Tour story: answer the pitch (first game)")
    run("Tour story: answer the pitch (own words)")
    run("Tour story: answer World's question (Red)")
    run("Tour agent: stop")
    run("Tour story: the lead's pitch waits until nudged")
    run("Tour story: Core stays quiet until nudged")
    run("Tour story: World asks about the hero's colour")
    expect(sheets).toEqual([0, "Space pirates"])
    expect(mates).toEqual([0])
    expect(stopped).toEqual(["stop"])
    expect(tour.take()).toEqual({
      quiet: false,
      quietTeam: true,
      quietMate: true,
      mateAsks: true,
    })
  })

  it("has the lead exit to its shell", () => {
    const tour = tourOf()
    const run = runner(tour)
    let left = 0
    tour.shelled(() => (left += 1))
    run("Tour agent: exits to its shell")
    expect(left).toBe(1)
  })

  it("has the next run without a page, and keeping fail once", async () => {
    const tour = tourOf()
    const run = runner(tour)
    run("Tour story: no page (as on a computer without Node or Python)")
    await expect(tour.prepare()).resolves.toMatchObject({ page: false })
    tour.take()
    await expect(tour.prepare()).resolves.toMatchObject({ page: true })
    run("Tour story: keeping fails")
    await expect(tour.keep!()).rejects.toThrow()
    await expect(tour.keep!()).resolves.toBeUndefined()
  })
})
