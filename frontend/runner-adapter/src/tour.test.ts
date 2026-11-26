import type { BundledPiFetchState, TourRun } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import type { Runner } from "@novadeck/runner-client"
import { WireError } from "@novadeck/wire"
import { describe, expect, it } from "vitest"

import { runnerTour } from "./backend"

const run: TourRun = {
  directory: "/home/x/.novadeck/tour",
  command: "opencode --model openrouter/openai/gpt-6-luna",
  brief: "launch",
  model: "openrouter/openai/gpt-6-luna",
  removed: [],
  page: true,
}

const tourAnswering = (prepare: () => Promise<TourRun>): Runner["tour"] =>
  ({
    prepare,
    brief: () => Promise.resolve(),
    artist: (terminalId: string) => (rung.push(terminalId), Promise.resolve()),
    keep: () => (kept.push(true), Promise.resolve()),
    fetch: () => (fetched.push(true), Promise.resolve()),
  }) as unknown as Runner["tour"]

// The terminals the runner was asked to ring the artist's brief to, and the keeps it was asked.
const rung: string[] = []
const kept: boolean[] = []
const fetched: boolean[] = []
const agent = createStore<BundledPiFetchState>({ state: "off" })

const track = <T>(work: Promise<T>): Promise<T> => work

describe("The runner's tour", () => {
  it("answers the run the runner readied", async () => {
    const tour = runnerTour(
      tourAnswering(() => Promise.resolve(run)),
      track,
      agent,
    )
    await expect(tour.prepare()).resolves.toEqual(run)
  })

  it("rings the artist's brief to the terminal, as the runner's call", async () => {
    const tour = runnerTour(
      tourAnswering(() => Promise.resolve(run)),
      track,
      agent,
    )
    await expect(tour.artist?.("t7")).resolves.toBeUndefined()
    expect(rung).toEqual(["t7"])
  })

  it("keeps the project, as the runner's call", async () => {
    const tour = runnerTour(
      tourAnswering(() => Promise.resolve(run)),
      track,
      agent,
    )
    await expect(tour.keep?.()).resolves.toBeUndefined()
    expect(kept).toEqual([true])
  })

  it("starts the download of Novadeck's pi as the runner's call, and shows where it stands", async () => {
    const tour = runnerTour(
      tourAnswering(() => Promise.resolve(run)),
      track,
      agent,
    )
    await expect(tour.fetch()).resolves.toBeUndefined()
    expect(fetched).toEqual([true])
    expect(tour.agent).toBe(agent)
  })

  it("passes any other refusal on as it came", async () => {
    const conflict = new WireError("CONFLICT", "The tour is already starting.")
    const tour = runnerTour(
      tourAnswering(() => Promise.reject(conflict)),
      track,
      agent,
    )
    await expect(tour.prepare()).rejects.toBe(conflict)
  })
})
