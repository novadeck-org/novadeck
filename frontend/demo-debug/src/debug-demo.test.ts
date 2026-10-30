import { noTheme } from "@novadeck/terminal-views/theme"
import { vi } from "vitest"

import { createBootRehearsals } from "./boot-rehearsal"
import { createDebugDemo, type DemoLaunch } from "./debug-demo"
import { describe, expect, it } from "./test"

// What the demo's terminals were told: started or stopped.
const life = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock("@novadeck/demo", async (original) => {
  const index = await original<typeof import("@novadeck/demo")>()
  return {
    ...index,
    demoTerminalsLife: (...args: Parameters<typeof index.demoTerminalsLife>) => {
      const terminals = index.demoTerminalsLife(...args)
      return (
        terminals && {
          start: () => {
            life.calls.push("start")
            terminals.start()
          },
          stop: () => {
            life.calls.push("stop")
            terminals.stop()
          },
        }
      )
    },
  }
})

const launch = (): DemoLaunch => ({
  rehearsals: createBootRehearsals(),
  theme: noTheme,
  variant: "plain",
  slowAttach: false,
  switchVariant: () => {},
  armSlowAttach: () => {},
  sandbox: undefined,
  setSandbox: () => {},
  portable: undefined,
  setPortable: () => {},
  bootInstalled: () => {},
  play: undefined,
  uninstall: undefined,
  setUninstall: () => {},
})

describe("the debug layer's demo", () => {
  it("starts its terminals with it, and stops them with it, so a reboot leaves none behind", () => {
    life.calls.length = 0
    const backend = createDebugDemo(launch())
    const stop = backend.start!({ dispatch: () => {}, open: () => {} })
    expect(life.calls).toEqual(["start"])
    stop()
    expect(life.calls).toEqual(["start", "stop"])
  })
})
