import type { ProjectWindowsState, ProjectWindowTarget } from "@novadeck/protocol/bridge"

import { describe, expect, it } from "../../test"
import { createProjectWindows, mostWindows } from "./project-windows"

// Windows are named by letters; the project each opens on, when it opens on one, by number.
const setup = () => {
  const told = new Map<string, ProjectWindowsState>()
  const forwarded: string[] = []
  const navigated: { window: string; target: ProjectWindowTarget }[] = []
  const created: string[] = []
  const voices: [string | undefined, string | undefined][] = []
  const windows = createProjectWindows<string>({
    create: (projectId) => {
      const window = `new-${projectId}`
      created.push(window)
      return window
    },
    forward: (window) => void forwarded.push(window),
    tell: (window, state) => void told.set(window, state),
    navigate: (window, target) => void navigated.push({ window, target }),
    voiceMoved: (from, to) => void voices.push([from, to]),
  })
  return { windows, told, forwarded, navigated, created, voices }
}

describe("a project shown in other windows", () => {
  it("tells each window the projects the others show", () => {
    const { windows, told } = setup()
    windows.add("a", "p1")
    windows.add("b", "p2")
    windows.add("c")
    expect(told.get("a")?.elsewhere).toEqual(["p2"])
    expect(told.get("b")?.elsewhere).toEqual(["p1"])
    expect(told.get("c")?.elsewhere).toEqual(["p1", "p2"])
  })

  it("follows a window's page changing project, and a window closing", () => {
    const { windows, told } = setup()
    windows.add("a", "p1")
    windows.add("b", "p2")
    windows.show("b", "p3")
    expect(told.get("a")?.elsewhere).toEqual(["p3"])
    windows.remove("b")
    expect(told.get("a")?.elsewhere).toEqual([])
  })
})

describe("the voice", () => {
  it("is the first window until another is used, then the one used last", () => {
    const { windows, told, voices } = setup()
    windows.add("a", "p1")
    windows.add("b", "p2")
    expect(told.get("a")?.voice).toBe(true)
    expect(told.get("b")?.voice).toBe(false)
    windows.used("b")
    expect(told.get("a")?.voice).toBe(false)
    expect(told.get("b")?.voice).toBe(true)
    expect(voices.at(-1)).toEqual(["a", "b"])
  })

  it("passes to the window used before when the voice's window closes", () => {
    const { windows, told } = setup()
    windows.add("a", "p1")
    windows.add("b", "p2")
    windows.add("c", "p3")
    windows.used("b")
    windows.used("c")
    windows.remove("c")
    expect(windows.voice()).toBe("b")
    expect(told.get("b")?.voice).toBe(true)
  })

  it("falls to the first window that remains when none was ever used", () => {
    const { windows } = setup()
    windows.add("a", "p1")
    windows.add("b", "p2")
    windows.remove("a")
    expect(windows.voice()).toBe("b")
  })
})

describe("opening a project in a window of its own", () => {
  it("creates a window that shows it from the start", () => {
    const { windows, created, told } = setup()
    windows.add("a", "p1")
    windows.show("a", "p1", ["p1", "p2"])
    windows.open("a", "p2")
    expect(created).toEqual(["new-p2"])
    expect(told.get("a")?.elsewhere).toEqual(["p2"])
  })

  it("brings forward the window that already shows it", () => {
    const { windows, created, forwarded } = setup()
    windows.add("a", "p1")
    windows.add("b", "p2")
    windows.open("a", "p2")
    expect(created).toEqual([])
    expect(forwarded).toEqual(["b"])
  })

  it("does nothing for the project the window shows itself", () => {
    const { windows, created, forwarded } = setup()
    windows.add("a", "p1")
    windows.open("a", "p1")
    expect(created).toEqual([])
    expect(forwarded).toEqual([])
  })

  it("opens one window for two asks before its page reports", () => {
    const { windows, created } = setup()
    windows.add("a", "p1")
    windows.show("a", "p1", ["p1", "p2"])
    windows.open("a", "p2")
    windows.open("a", "p2")
    expect(created).toEqual(["new-p2"])
  })
})

describe("opening a window the app may not", () => {
  it("opens nothing on a project no page knows", () => {
    const { windows, created } = setup()
    windows.add("a", "p1")
    windows.show("a", "p1", ["p1"])
    windows.open("a", "made-up")
    expect(created).toEqual([])
  })

  it("learns the projects a page tells of, and forgets a window's when it closes", () => {
    const { windows, created } = setup()
    windows.add("a", "p1")
    windows.add("b", "p2")
    windows.show("b", "p2", ["p2", "p3"])
    windows.open("a", "p3")
    expect(created).toEqual(["new-p3"])
    windows.remove("new-p3")
    windows.remove("b")
    windows.open("a", "p3")
    expect(created).toEqual(["new-p3"])
  })

  it("opens no more windows than the most it allows", () => {
    const { windows, created } = setup()
    windows.add("w0", "p0")
    const ids = Array.from({ length: mostWindows + 4 }, (_, index) => `p${index + 1}`)
    windows.show("w0", "p0", ids)
    for (const id of ids) windows.open("w0", id)
    expect(created).toHaveLength(mostWindows - 1)
    expect(windows.size()).toBe(mostWindows)
  })
})

describe("swapping two windows' projects", () => {
  // Each window's changes reach the other live through the runner: nothing is waited for.
  it("gives the other window this window's former project and sends it there at once", () => {
    const { windows, navigated, told } = setup()
    windows.add("a", "p1")
    windows.add("b", "p2")
    expect(windows.swap("b", "p1")).toBe("swapped")
    expect(navigated).toEqual([{ window: "a", target: { projectId: "p2" } }])
    expect(told.get("b")?.elsewhere).toEqual(["p2"])
    expect(told.get("a")?.elsewhere).toEqual(["p1"])
  })

  it("brings the other window forward, sends it nowhere and leaves this one where it is, when this one hadn't said what it showed", async () => {
    const { windows, navigated, forwarded, told } = setup()
    windows.add("a")
    windows.add("b", "p2")
    expect(windows.swap("a", "p2")).toBe("forwarded")
    expect(navigated).toEqual([])
    expect(forwarded).toEqual(["b"])
    expect(told.get("b")?.elsewhere).toEqual([])
  })

  it("only records the window's project when no other window shows it", async () => {
    const { windows, navigated, told } = setup()
    windows.add("a", "p1")
    windows.add("b", "p2")
    expect(windows.swap("a", "p3")).toBe("alone")
    expect(navigated).toEqual([])
    expect(told.get("b")?.elsewhere).toEqual(["p3"])
  })
})

describe("handing a place in a project to its window", () => {
  it("brings the window that shows the project forward and sends it there", () => {
    const { windows, forwarded, navigated } = setup()
    windows.add("a", "p1")
    windows.add("b", "p2")
    windows.handOff("a", { projectId: "p2", terminalId: "t1" })
    expect(forwarded).toEqual(["b"])
    expect(navigated).toEqual([{ window: "b", target: { projectId: "p2", terminalId: "t1" } }])
  })

  it("never raises a window for what an agent asked, only sends it there", () => {
    const { windows, forwarded, navigated } = setup()
    windows.add("a", "p1")
    windows.add("b", "p2")
    windows.handOff("a", { projectId: "p2", terminalId: "t1", quiet: true })
    windows.handOff("a", { projectId: "p3", quiet: true })
    expect(forwarded).toEqual([])
    expect(navigated.map(({ window }) => window)).toEqual(["b", "a"])
  })

  it("tells the asking window when no window shows the project", () => {
    const { windows, forwarded, navigated } = setup()
    windows.add("a", "p1")
    windows.add("b", "p2")
    windows.handOff("a", { projectId: "p3", terminalId: "t9" })
    expect(forwarded).toEqual(["a"])
    expect(navigated).toEqual([{ window: "a", target: { projectId: "p3", terminalId: "t9" } }])
  })
})
