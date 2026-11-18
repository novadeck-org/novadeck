import { context, describe, expect, it } from "../../test"
import { createQueue } from "./thumbs"

// A job that runs until it is let go, noting when it began.
const jobs = () => {
  const began: string[] = []
  const release = new Map<string, () => void>()
  const job = (name: string) => (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      began.push(name)
      release.set(name, resolve)
      signal.addEventListener("abort", () => resolve())
    })
  return { began, release, job }
}

describe("the pictures of a folder's grid", () => {
  context("read through a queue", () => {
    it("runs a few at a time, the nearest to the middle first", async () => {
      const { began, release, job } = jobs()
      const queue = createQueue(2)
      queue.want(() => 500, job("far"))
      queue.want(() => 10, job("near"))
      queue.want(() => 300, job("middle"))
      queue.want(() => 1, job("nearest"))
      // The first two to be asked ran at once, as the queue had room; the rest wait their turn by nearness.
      expect(began).toEqual(["far", "near"])
      release.get("far")!()
      await Promise.resolve()
      await Promise.resolve()
      expect(began).toEqual(["far", "near", "nearest"])
      release.get("near")!()
      await Promise.resolve()
      await Promise.resolve()
      expect(began).toEqual(["far", "near", "nearest", "middle"])
    })

    it("measures nearness when a place frees, as what is near changes while the grid scrolls", async () => {
      const { began, release, job } = jobs()
      const queue = createQueue(1)
      let first = 1
      let second = 2
      queue.want(() => 0, job("running"))
      queue.want(() => first, job("a"))
      queue.want(() => second, job("b"))
      first = 9
      second = 3
      release.get("running")!()
      await Promise.resolve()
      await Promise.resolve()
      expect(began).toEqual(["running", "b"])
    })

    it("lets go of a job that is no longer wanted, running or not", async () => {
      const { began, release, job } = jobs()
      const queue = createQueue(1)
      const stopRunning = queue.want(() => 0, job("running"))
      const stopWaiting = queue.want(() => 1, job("waiting"))
      queue.want(() => 2, job("last"))
      stopWaiting()
      stopRunning()
      await Promise.resolve()
      await Promise.resolve()
      expect(began).toEqual(["running", "last"])
      expect(release.has("waiting")).toBe(false)
    })
  })
})
