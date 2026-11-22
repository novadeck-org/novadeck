import { TourNeedsAgent, type TourRun } from "@novadeck/core/port"
import type { Runner } from "@novadeck/runner-client"
import { WireError } from "@novadeck/wire"
import { describe, expect, it } from "vitest"

import { runnerTour } from "./backend"

const run: TourRun = {
  directory: "/home/x/.novadeck/tour",
  command: "codex --model gpt-6-luna",
  brief: "launch",
  model: "gpt-6-luna",
  removed: [],
  page: true,
}

const tourAnswering = (prepare: () => Promise<TourRun>): Runner["tour"] =>
  ({
    prepare,
    brief: () => Promise.resolve(),
    artist: (terminalId: string) => (rung.push(terminalId), Promise.resolve()),
    keep: () => (kept.push(true), Promise.resolve()),
  }) as unknown as Runner["tour"]

// The terminals the runner was asked to ring the artist's brief to, and the keeps it was asked.
const rung: string[] = []
const kept: boolean[] = []

const track = <T>(work: Promise<T>): Promise<T> => work

describe("The runner's tour", () => {
  it("answers the run the runner readied", async () => {
    const tour = runnerTour(
      tourAnswering(() => Promise.resolve(run)),
      track,
    )
    await expect(tour.prepare("codex")).resolves.toEqual(run)
  })

  it("names the agent to start first where it hasn't listed its models", async () => {
    const tour = runnerTour(
      tourAnswering(() =>
        Promise.reject(new WireError("MODELS_UNLISTED", "Codex hasn't listed its models.")),
      ),
      track,
    )
    const refused = await tour.prepare("codex").catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(TourNeedsAgent)
    expect(refused).toMatchObject({ agent: "codex", message: "Codex hasn't listed its models." })
  })

  it("rings the artist's brief to the terminal, as the runner's call", async () => {
    const tour = runnerTour(
      tourAnswering(() => Promise.resolve(run)),
      track,
    )
    await expect(tour.artist?.("t7")).resolves.toBeUndefined()
    expect(rung).toEqual(["t7"])
  })

  it("keeps the project, as the runner's call", async () => {
    const tour = runnerTour(
      tourAnswering(() => Promise.resolve(run)),
      track,
    )
    await expect(tour.keep?.()).resolves.toBeUndefined()
    expect(kept).toEqual([true])
  })

  it("passes any other refusal on as it came", async () => {
    const conflict = new WireError("CONFLICT", "The tour is already starting.")
    const tour = runnerTour(
      tourAnswering(() => Promise.reject(conflict)),
      track,
    )
    await expect(tour.prepare("claude")).rejects.toBe(conflict)
  })
})
