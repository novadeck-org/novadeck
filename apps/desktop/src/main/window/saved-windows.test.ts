import { describe, expect, it } from "../../test"
import { boundsToOpen, keepWindows, noSavedWindows, savedWindowsOf } from "./saved-windows"

const bounds = { x: 10, y: 20, width: 1000, height: 700 }
const key = "0b0f6a5e-1c3d-4e8f-9a7b-2d4c6e8f0a1b"
const other = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f"
const uuid = expect.stringMatching(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)

describe("the saved windows a file holds", () => {
  it("are the well formed ones, rounded to whole pixels", () => {
    expect(
      savedWindowsOf({
        on: true,
        windows: [
          { key, projectId: "p1", bounds: { ...bounds, x: 10.4 }, maximized: true },
          { key: other, projectId: "p2", bounds },
        ],
      }),
    ).toEqual({
      on: true,
      windows: [
        { key, projectId: "p1", bounds, maximized: true },
        { key: other, projectId: "p2", bounds, maximized: false },
      ],
    })
  })

  it("give an entry from before keys a key, and each window a key of its own", () => {
    const { windows } = savedWindowsOf({
      on: true,
      windows: [
        { projectId: "p1", bounds },
        { key: "not a key", projectId: "p1", bounds },
        { key, projectId: "p1", bounds },
        { key, projectId: "p1", bounds },
      ],
    })
    expect(windows.map((each) => each.key)).toEqual([uuid, uuid, key, uuid])
    expect(new Set(windows.map((each) => each.key)).size).toBe(4)
  })
  it("leave out a window with no project or with bounds that make no sense", () => {
    expect(
      savedWindowsOf({
        on: true,
        windows: [
          { bounds },
          { projectId: "p", bounds: { ...bounds, width: 20 } },
          { projectId: "p", bounds: { ...bounds, x: "left" } },
          "window",
          null,
        ],
      }).windows,
    ).toEqual([])
  })

  it("are nothing where the file is no object, and off unless it says it is on", () => {
    expect(savedWindowsOf("windows")).toEqual(noSavedWindows)
    expect(savedWindowsOf(null)).toEqual(noSavedWindows)
    expect(savedWindowsOf({ windows: [] }).on).toBe(false)
  })

  it("never list more than a person has screens for", () => {
    const windows = Array.from({ length: 40 }, () => ({ key, projectId: "p", bounds }))
    expect(savedWindowsOf({ on: true, windows }).windows).toHaveLength(16)
  })
})

describe("where a saved window opens", () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1080 }

  it("is where it stood while that is on a screen", () => {
    expect(boundsToOpen(bounds, [screen])).toEqual(bounds)
  })

  it("leaves its place to the system when its screen has gone", () => {
    expect(boundsToOpen({ ...bounds, x: 3000 }, [screen])).toEqual({ width: 1000, height: 700 })
  })
})

const files = () => {
  const written = new Map<string, string>()
  return {
    written,
    readFile: (path: string) =>
      written.has(path) ? Promise.resolve(written.get(path)!) : Promise.reject(new Error("none")),
    writeFile: (path: string, data: string) => {
      written.set(path, data)
      return Promise.resolve()
    },
    rename: (from: string, to: string) => {
      written.set(to, written.get(from)!)
      written.delete(from)
      return Promise.resolve()
    },
    rm: (path: string) => {
      written.delete(path)
      return Promise.resolve()
    },
  }
}

describe("keeping the windows for the next launch", () => {
  const window = { key, projectId: "p1", bounds, maximized: false }

  it("keeps the open windows only while project windows are on", async () => {
    const disk = files()
    const kept = keepWindows("windows.json", disk)
    await kept.load()
    await kept.remember([window])
    expect(disk.written.size).toBe(0)
    await kept.use(true)
    await kept.remember([window])
    expect(JSON.parse(disk.written.get("windows.json")!)).toEqual({ on: true, windows: [window] })
  })

  it("forgets the windows when project windows are turned off", async () => {
    const disk = files()
    const kept = keepWindows("windows.json", disk)
    await kept.load()
    await kept.use(true)
    await kept.remember([window])
    await kept.use(false)
    expect(JSON.parse(disk.written.get("windows.json")!)).toEqual({ on: false, windows: [] })
  })

  it("reads back what it kept, and nothing from a file that is broken", async () => {
    const disk = files()
    const first = keepWindows("windows.json", disk)
    await first.load()
    await first.use(true)
    await first.remember([window])
    expect(await keepWindows("windows.json", disk).load()).toEqual({ on: true, windows: [window] })
    disk.written.set("windows.json", "{not json")
    expect(await keepWindows("windows.json", disk).load()).toEqual(noSavedWindows)
  })

  it("keeps two windows on one project, each under its own key", async () => {
    const disk = files()
    const first = keepWindows("windows.json", disk)
    await first.load()
    await first.use(true)
    const second = { ...window, key: other }
    await first.remember([window, second])
    const { windows } = await keepWindows("windows.json", disk).load()
    expect(windows).toEqual([window, second])
  })

  it("writes back the keys it gave older entries, so they hold across launches", async () => {
    const disk = files()
    const old = { projectId: "p1", bounds, maximized: false }
    disk.written.set("windows.json", JSON.stringify({ on: true, windows: [old, old] }))
    const first = await keepWindows("windows.json", disk).load()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = await keepWindows("windows.json", disk).load()
    expect(second.windows).toEqual(first.windows)
    expect(second.windows[0]!.key).not.toBe(second.windows[1]!.key)
  })
})
