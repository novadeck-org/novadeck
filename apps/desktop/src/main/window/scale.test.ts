import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { IpcMainEvent } from "electron"
import { afterEach, beforeEach } from "vitest"

import { scaleChannel } from "../../bridge.js"
import { context, describe, expect, it } from "../../test"
import { keepScale, registerScaleIpc, scaleOf, type ScaledPage } from "./scale"

describe("the scale a page reports", () => {
  it("is kept within 80% and 200%", () => {
    expect(scaleOf(0.8)).toBe(0.8)
    expect(scaleOf(1.25)).toBe(1.25)
    expect(scaleOf(2)).toBe(2)
    expect(scaleOf(0.1)).toBe(0.8)
    expect(scaleOf(-3)).toBe(0.8)
    expect(scaleOf(5)).toBe(2)
    expect(scaleOf(Infinity)).toBe(1)
  })

  it("is normal when it is not a number", () => {
    for (const bad of [undefined, null, "2", {}, [2], Number.NaN]) expect(scaleOf(bad)).toBe(1)
  })
})

// A page that records the zoom it is given.
const page = (): ScaledPage & { zoom: number; gone: boolean } => {
  const shown = {
    zoom: 1,
    gone: false,
    setZoomFactor: (factor: number) => void (shown.zoom = factor),
    isDestroyed: () => shown.gone,
  }
  return shown
}

describe("keeping the scale between launches", () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "novadeck-scale-"))
  })
  afterEach(() => rm(directory, { recursive: true, force: true }))

  it("shows a change in every window at once, a closed one left alone", async () => {
    const [one, two, closed] = [page(), page(), page()]
    closed.gone = true
    const kept = keepScale(join(directory, "scale.json"), () => [one, two, closed])
    await kept.set(1.5)
    expect([one.zoom, two.zoom, closed.zoom]).toEqual([1.5, 1.5, 1])
  })

  it("tells who zooms each page it showed the scale in, once it has", async () => {
    const [one, closed] = [page(), page()]
    closed.gone = true
    const told: number[] = []
    const kept = keepScale(
      join(directory, "scale.json"),
      () => [one, closed],
      (zoomed) => void told.push(zoomed.zoom),
    )
    await kept.set(1.5)
    expect(told).toEqual([1.5])
  })

  it("opens a later window at the scale, wherever its page loads again", async () => {
    const later = page()
    const kept = keepScale(join(directory, "scale.json"), () => [later])
    await kept.set(2)
    later.zoom = 1
    kept.apply(later)
    expect(later.zoom).toBe(2)
  })

  it("starts the next launch at the last scale", async () => {
    const file = join(directory, "scale.json")
    await keepScale(file, () => []).set(0.8)
    await keepScale(file, () => []).set(1.75)
    const next = keepScale(file, () => [])
    expect(await next.load()).toBe(1.75)
    expect(next.current()).toBe(1.75)
  })

  it("keeps a clamped scale, not the one it was told", async () => {
    const file = join(directory, "scale.json")
    await keepScale(file, () => []).set(9)
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ scale: 2 })
  })

  it("writes nothing when the scale kept is the one set", async () => {
    const file = join(directory, "scale.json")
    const kept = keepScale(file, () => [])
    await kept.set(1.1)
    await writeFile(file, "changed elsewhere")
    await kept.set(1.1)
    expect(await readFile(file, "utf8")).toBe("changed elsewhere")
  })

  context("when the kept file is missing, corrupt or out of range", () => {
    it("is normal, or clamped", async () => {
      const corrupt = join(directory, "corrupt.json")
      const wild = join(directory, "wild.json")
      await writeFile(corrupt, "{")
      await writeFile(wild, JSON.stringify({ scale: 0.4 }))
      expect(await keepScale(join(directory, "none.json"), () => []).load()).toBe(1)
      expect(await keepScale(corrupt, () => []).load()).toBe(1)
      expect(await keepScale(wild, () => []).load()).toBe(0.8)
    })
  })
})

describe("following the page's scale reports", () => {
  const registered = (own: boolean) => {
    const listeners = new Map<string, (event: IpcMainEvent, value: unknown) => void>()
    const set: unknown[] = []
    registerScaleIpc(
      { on: (channel, listener) => void listeners.set(channel, listener) },
      () => own,
      (value) => void set.push(value),
    )
    return {
      report: (value: unknown) => listeners.get(scaleChannel)?.({} as IpcMainEvent, value),
      set,
    }
  }

  it("sets the scale a page of the app reports", () => {
    const { report, set } = registered(true)
    report(1.5)
    expect(set).toEqual([1.5])
  })

  it("drops a report from any other sender", () => {
    const { report, set } = registered(false)
    report(2)
    expect(set).toEqual([])
  })
})
