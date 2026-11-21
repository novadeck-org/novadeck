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

describe("the tour group", () => {
  it("fails only the next start, as a folder of the person's own does", async () => {
    const tour = tourOf()
    const [group] = tourGroups(tour)
    void group!.actions.find((each) => each.label === "Fail next start")!.run({} as never)
    await expect(tour.prepare("claude")).rejects.toThrow(demoTourRefusal)
    await expect(tour.prepare("claude")).resolves.toMatchObject({
      directory: "~/.novadeck/tour",
      brief: "launch",
      model: "haiku",
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
    const [group] = tourGroups(tour)
    const run = (label: string) =>
      void group!.actions.find((each) => each.label === label)!.run({} as never)
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
    for (const action of group!.actions) expect(action.hint.length).toBeGreaterThan(20)
  })
})

describe("the tour the debug panel shares with the demo", () => {
  it("runs the agents the panel connects, once it follows them", async () => {
    const tour = demoTour(createStore<readonly AgentConnection[]>([]), () => undefined)
    await expect(tour.prepare("claude")).rejects.toThrow()
    tour.follow(createStore(connected), () => undefined)
    await expect(tour.prepare("claude")).resolves.toMatchObject({ model: "haiku" })
  })

  it("drives the story: answers the money ask, quiets the fixer, stops the agent", () => {
    const tour = tourOf()
    const [group] = tourGroups(tour)
    const run = (label: string) =>
      void group!.actions.find((each) => each.label === label)!.run({} as never)
    const picked: number[] = []
    const stopped: string[] = []
    tour.money((option) => picked.push(option))
    tour.stopped(() => stopped.push("stop"))
    run("Tour story: answer the money ask (A)")
    run("Tour story: answer the money ask (B)")
    run("Tour agent: stop")
    run("Tour story: the lead's fixer stays quiet until nudged")
    expect(picked).toEqual([0, 1])
    expect(stopped).toEqual(["stop"])
    expect(tour.take()).toEqual({ quiet: false, quietTeam: true })
    expect(tour.take()).toEqual({ quiet: false })
    for (const action of group!.actions) expect(action.hint).toBeTruthy()
  })
})
