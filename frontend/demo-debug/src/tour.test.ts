import type { AgentConnection } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import { demoTour } from "@novadeck/demo/tour"
import { demoTourRefusal } from "@novadeck/demo/tour-runs"

import { describe, expect, it } from "./test"
import { tourGroups } from "./tour"

const connected: readonly AgentConnection[] = [
  { agent: "claude", available: true, connected: true, busy: false },
]

const tourOf = () => demoTour(createStore(connected), () => undefined)

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
    await expect(tour.prepare("claude")).rejects.toThrow(demoTourRefusal)
    await expect(tour.prepare("claude")).resolves.toMatchObject({
      directory: "~/.novadeck/tour",
      brief: "launch",
      model: "haiku",
      page: true,
    })
  })

  it("refuses an agent that isn't connected, and leaves Antigravity's line to the doorbell", async () => {
    const tour = demoTour(
      createStore<readonly AgentConnection[]>([
        { agent: "agy", available: true, connected: true, busy: false },
      ]),
      () => undefined,
    )
    await expect(tour.prepare("claude")).rejects.toThrow()
    await expect(tour.prepare("agy")).resolves.toMatchObject({ brief: "doorbell" })
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
  it("runs the agents the panel connects, once it follows them", async () => {
    const tour = demoTour(createStore<readonly AgentConnection[]>([]), () => undefined)
    await expect(tour.prepare("claude")).rejects.toThrow()
    tour.follow(createStore(connected), () => undefined)
    await expect(tour.prepare("claude")).resolves.toMatchObject({ model: "haiku" })
  })

  it("drives the story: answers the hero ask, quiets the team, the sculptor and the artist", () => {
    const tour = tourOf()
    const run = runner(tour)
    const picked: (number | string)[] = []
    const stopped: string[] = []
    tour.hero((answer) => picked.push(answer))
    tour.stopped(() => stopped.push("stop"))
    run("Tour story: answer the hero ask (A rocket)")
    run("Tour story: answer the hero ask (own words)")
    run("Tour agent: stop")
    run("Tour story: the lead's team stays quiet until nudged")
    run("Tour story: the sculptor stays quiet until nudged")
    run("Tour story: the artist stays quiet until nudged")
    expect(picked).toEqual([0, "my cat Pixel"])
    expect(stopped).toEqual(["stop"])
    expect(tour.take()).toEqual({
      quiet: false,
      quietTeam: true,
      quietSculptor: true,
      quietArtist: true,
    })
    expect(tour.artistQuiet()).toBe(true)
    tour.take()
    expect(tour.artistQuiet()).toBe(false)
  })

  it("has the artist never start, and the lead exit to its shell", () => {
    const tour = tourOf()
    const run = runner(tour)
    run("Tour story: the artist never starts")
    tour.take()
    expect(tour.artistNever()).toBe(true)
    tour.take()
    expect(tour.artistNever()).toBe(false)
    let left = 0
    tour.shelled(() => (left += 1))
    run("Tour agent: exits to its shell")
    expect(left).toBe(1)
  })

  it("has the next run without a page, and keeping fail once", async () => {
    const tour = tourOf()
    const run = runner(tour)
    run("Tour story: no page (as on a computer without Node or Python)")
    await expect(tour.prepare("claude")).resolves.toMatchObject({ page: false })
    tour.take()
    await expect(tour.prepare("claude")).resolves.toMatchObject({ page: true })
    run("Tour story: keeping fails")
    await expect(tour.keep!()).rejects.toThrow()
    await expect(tour.keep!()).resolves.toBeUndefined()
  })
})
