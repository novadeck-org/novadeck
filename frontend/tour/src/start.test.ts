import type { Tour, TourRun } from "@novadeck/core/port"

import { startTour, type TourEffects } from "./start"
import { describe, expect, it } from "./test"

const run = (brief: TourRun["brief"]): TourRun => ({
  directory: "/home/x/.novadeck/tour",
  command: brief === "launch" ? 'opencode --model m "Start"' : "opencode --model m",
  brief,
  removed: ["old"],
  page: true,
})

// The effects, each recording what it was asked to do, in order.
const effects = (prepared: Promise<TourRun>): TourEffects & { readonly done: string[] } => {
  const done: string[] = []
  const tour: Tour = {
    prepare: () => {
      done.push("prepare")
      return prepared
    },
    brief: (terminalId) => {
      done.push(`brief ${terminalId}`)
      return Promise.resolve()
    },
  }
  return {
    done,
    tour,
    openTour: ({ removed }) => void done.push(`open in place of ${removed.join(",")}`),
    add: ({ command }) => {
      done.push(`add ${command}`)
      return "t1"
    },
  }
}

describe("Starting the tour", () => {
  it("opens its project and starts the agent there", async () => {
    const world = effects(Promise.resolve(run("launch")))
    const started = await startTour(world)
    expect(started).toMatchObject({ terminalId: "t1", run: { brief: "launch" } })
    expect(world.done).toEqual([
      "prepare",
      "open in place of old",
      'add opencode --model m "Start"',
    ])
  })

  it("leaves a doorbell's first line to the tour's driver", async () => {
    const world = effects(Promise.resolve(run("doorbell")))
    await startTour(world)
    expect(world.done).not.toContain("brief t1")
  })

  it("changes nothing in the workspace where the backend refuses", async () => {
    const world = effects(Promise.reject(new Error("not Novadeck's folder")))
    await expect(startTour(world)).rejects.toThrow("not Novadeck's folder")
    expect(world.done).toEqual(["prepare"])
  })
})
