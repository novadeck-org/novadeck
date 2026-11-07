import type { TerminalKey, TerminalMountProps, ViewState } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import type { ViewMode } from "@novadeck/core/types"
import type { Hold, ShowOptions } from "@novadeck/terminal/view"
import { vi } from "vitest"

import { createTerminalMount } from "./mount"
import { context, describe, expect, it } from "./test"

type Asked = { readonly label?: string; readonly phase?: string; readonly webgl?: boolean }

const opening: ViewState = { live: false, resuming: false, waits: false, lock: null, notice: null }

// Screens that record what each mount asks of them: each acquire hands out a hold on a screen
// whose state the test sets, as a backend's screens would change it.
const recorded = () => {
  const asked: Asked[] = []
  const calls: string[] = []
  const screen = createStore<ViewState>({ ...opening, live: true })
  const acquire = (key: TerminalKey, options: ShowOptions): Hold => {
    asked.push(options)
    calls.push(`acquire ${key.terminalId}`)
    return {
      state: screen,
      place: () => void calls.push("place"),
      update: (change) => void asked.push(change),
      focus: () => true,
      release: ({ unmount = false } = {}) => void calls.push(unmount ? "unmount" : "release"),
    }
  }
  const restart = (key: TerminalKey): void => void calls.push(`restart ${key.terminalId}`)
  return { asked, calls, screen, screens: { acquire, restart } }
}

const key: TerminalKey = { projectId: "p", workspaceSessionId: "s", terminalId: "t" }
const props = (view: ViewMode, onScreen?: boolean): TerminalMountProps => ({
  name: "zsh",
  status: "running",
  view,
  ...(onScreen !== undefined && { onScreen }),
})

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

  context("when its terminal is seen", () => {
    it("holds the terminal seen while the prop says so, once, and lets it go on dispose", () => {
      const { screens } = recorded()
      const held: string[] = []
      const seen = (seenKey: TerminalKey) => {
        held.push(`see ${seenKey.terminalId}`)
        return () => void held.push("unsee")
      }
      const sleeping = (wanted?: boolean): TerminalMountProps => ({
        ...props("grid"),
        status: "sleeping",
        ...(wanted ? { seen: true } : {}),
      })
      const mount = createTerminalMount(screens, seen)(
        document.createElement("div"),
        key,
        sleeping(),
      )
      mount.update(sleeping(true))
      mount.update(sleeping(true))
      mount.update(sleeping())
      mount.update(sleeping(true))
      mount.dispose()
      expect(held).toEqual(["see t", "unsee", "see t", "unsee"])
    })

    it("treats a sleeper as a shell that is starting, so typing is held back", () => {
      const { asked, screens } = recorded()
      createTerminalMount(screens)(document.createElement("div"), key, {
        ...props("grid"),
        status: "sleeping",
      })
      expect(asked[0]?.phase).toBe("starting")
    })
  })

  context("when it goes out of sight and back", () => {
    it("lets its screen go and takes it again, one release for each acquire", () => {
      const { calls, screens } = recorded()
      const mount = createTerminalMount(screens)(document.createElement("div"), key, props("grid"))
      mount.update(props("grid", false))
      mount.update(props("grid", false))
      mount.update(props("grid", true))
      mount.dispose()
      expect(calls).toEqual(["acquire t", "place", "release", "acquire t", "place", "unmount"])
    })

    it("takes no screen until it is first on screen", () => {
      const { calls, screens } = recorded()
      const mount = createTerminalMount(screens)(
        document.createElement("div"),
        key,
        props("canvas", false),
      )
      expect(calls).toEqual([])
      expect(mount.focus()).toBe(false)
      mount.update(props("canvas", true))
      expect(calls).toEqual(["acquire t", "place"])
    })

    it("tells its state once when it comes back to a screen in a new state", () => {
      const { screen, screens } = recorded()
      const mount = createTerminalMount(screens)(document.createElement("div"), key, props("grid"))
      const woken = vi.fn<() => void>()
      mount.state.subscribe(woken)
      mount.update(props("grid", false))
      screen.update((state) => ({ ...state, waits: true }))
      // Nothing is told while it is away, and it shows the state it last had.
      expect(woken).not.toHaveBeenCalled()
      expect(mount.state.getSnapshot().waits).toBe(false)
      mount.update(props("grid", true))
      expect(mount.state.getSnapshot().waits).toBe(true)
      expect(woken).toHaveBeenCalledTimes(1)
    })
  })

  context("once disposed", () => {
    it("lets its screen go once, and takes none again", () => {
      const { calls, screens } = recorded()
      const mount = createTerminalMount(screens)(document.createElement("div"), key, props("grid"))
      mount.dispose()
      mount.dispose()
      mount.update(props("grid", false))
      mount.update(props("grid", true))
      mount.restart()
      expect(calls).toEqual(["acquire t", "place", "unmount"])
    })

    it("releases nothing again when disposed off screen", () => {
      const { calls, screens } = recorded()
      const mount = createTerminalMount(screens)(document.createElement("div"), key, props("grid"))
      mount.update(props("grid", false))
      mount.dispose()
      expect(calls).toEqual(["acquire t", "place", "release"])
    })
  })

  context("when Restart is clicked", () => {
    it("restarts its terminal through the screens while it holds a screen", () => {
      const { calls, screens } = recorded()
      const mount = createTerminalMount(screens)(document.createElement("div"), key, props("grid"))
      mount.restart()
      expect(calls).toEqual(["acquire t", "place", "restart t"])
    })

    it("restarts its terminal while it waits for its turn to take a screen", () => {
      // A Canvas window in sight shows its ending bar before its screen is admitted.
      const { calls, screens } = recorded()
      const mount = createTerminalMount(screens)(
        document.createElement("div"),
        key,
        props("canvas", false),
      )
      mount.restart()
      expect(calls).toEqual(["restart t"])
    })
  })
})
