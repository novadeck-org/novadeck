import type { ProjectWindowsState } from "@novadeck/core/desktop/project-windows"
import { describe, expect, it } from "vitest"

import { createDemoProjectWindows } from "./project-windows"

const watched = () => {
  const demo = createDemoProjectWindows({ extra: false })
  const states: ProjectWindowsState[] = []
  demo.windows.onState((state) => states.push(state))
  return { demo, states }
}

describe("the demo's project windows", () => {
  it("says at once that no other window shows anything and this one has the voice", () => {
    const { states } = watched()
    expect(states).toEqual([{ elsewhere: [], voice: true }])
  })

  it("shows the projects the pretend windows show, and who has the voice", () => {
    const { demo, states } = watched()
    demo.pretend(["b", "c"])
    demo.setVoice(false)
    expect(states.at(-1)).toEqual({ elsewhere: ["b", "c"], voice: false })
  })

  it("opens a project in a pretend window of its own", () => {
    const { demo, states } = watched()
    demo.windows.open("b")
    demo.windows.open("b")
    expect(states.at(-1)?.elsewhere).toEqual(["b"])
  })

  it("sends the page where a pretend window says, and notes what the page hands over", () => {
    const { demo } = watched()
    const places: unknown[] = []
    demo.windows.onNavigate((place) => places.push(place))
    demo.send({ projectId: "b" })
    demo.windows.handOff({ projectId: "b", terminalId: "t" })
    expect(places).toEqual([{ projectId: "b" }])
    expect(demo.handedOff()).toEqual([{ projectId: "b", terminalId: "t" }])
  })
})
