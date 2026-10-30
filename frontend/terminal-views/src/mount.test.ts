import type { TerminalKey, TerminalMountProps } from "@novadeck/core/port"
import type { ViewMode } from "@novadeck/core/types"
import type { Hold } from "@novadeck/terminal/view"

import { createTerminalMount } from "./mount"
import { describe, expect, it } from "./test"

type Asked = { readonly label?: string; readonly phase?: string; readonly webgl?: boolean }

// Views whose screens record what each mount asks of them.
const recorded = () => {
  const asked: Asked[] = []
  const hold: Hold = {
    state: {
      getSnapshot: () => ({ live: true, resuming: false, waits: false, lock: null, notice: null }),
      subscribe: () => () => {},
    },
    place: () => {},
    update: (change) => void asked.push(change),
    focus: () => true,
    restart: () => {},
    release: () => {},
  }
  const acquire = (_key: TerminalKey, options: Asked): Hold => {
    asked.push(options)
    return hold
  }
  return { asked, screens: { acquire } }
}

const key: TerminalKey = { projectId: "p", workspaceSessionId: "s", terminalId: "t" }
const props = (view: ViewMode): TerminalMountProps => ({ name: "zsh", status: "running", view })

describe("a terminal's mount", () => {
  it("draws Grid and Focus with WebGL, never Canvas, which zooms with a transform", () => {
    const webglIn = (view: ViewMode) => {
      const { asked, screens } = recorded()
      createTerminalMount(screens)(document.createElement("div"), key, props(view))
      return asked[0]?.webgl
    }
    expect([webglIn("grid"), webglIn("focus"), webglIn("canvas")]).toEqual([true, true, false])
  })

  it("asks again when its view changes", () => {
    const { asked, screens } = recorded()
    const mount = createTerminalMount(screens)(document.createElement("div"), key, props("grid"))
    mount.update(props("canvas"))
    expect(asked).toEqual([
      { label: "Input for zsh", phase: "running", webgl: true },
      { label: "Input for zsh", phase: "running", webgl: false },
    ])
  })
})
