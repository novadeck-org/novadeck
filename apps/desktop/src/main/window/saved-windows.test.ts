import { describe, expect, it } from "../../test"
import { boundsToOpen, keepWindows, noSavedWindows, savedWindowsOf } from "./saved-windows"

const bounds = { x: 10, y: 20, width: 1000, height: 700 }

describe("the saved windows a file holds", () => {
  it("are the well formed ones, rounded to whole pixels", () => {
    expect(
      savedWindowsOf({
        on: true,
        windows: [
          { projectId: "p1", bounds: { ...bounds, x: 10.4 }, maximized: true },
          { projectId: "p2", bounds },
        ],
      }),
    ).toEqual({
      on: true,
      windows: [
        { projectId: "p1", bounds, maximized: true },
        { projectId: "p2", bounds, maximized: false },
      ],
    })
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
    const windows = Array.from({ length: 40 }, () => ({ projectId: "p", bounds }))
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
  const window = { projectId: "p1", bounds, maximized: false }

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
})
