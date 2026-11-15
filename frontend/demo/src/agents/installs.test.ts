import type { BackendAction } from "@novadeck/core/port"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { activeProject, activeSession } from "@novadeck/core/state"
import { afterEach, beforeEach, vi } from "vitest"

import { createDemoForges, demoForgeInstallers, demoSignIn } from "../forges"
import { demoBackend } from "../index"
import { createDemoEngine } from "../terminals/engine"
import { context, describe, expect, it } from "../test"
import { createDemoInstalls, demoInstallers, installMs, installReply } from "./installs"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// A demo backend whose Antigravity is not installed, started, with what it dispatches.
const started = () => {
  const installs = createDemoInstalls()
  // With forges, as the agents demo offers them beside `demoBackend`'s own.
  const backend = installs.wrap({
    ...demoBackend(createDemoEngine()),
    forges: createDemoForges(),
  })
  const workspace = workspaceFromSeed(backend.seed, {
    view: "grid",
    windowedView: "grid",
    now: 1,
  })
  backend.commit(workspace, [])
  const dispatched: BackendAction[] = []
  const stop = backend.start?.({
    dispatch: (actions) => dispatched.push(...actions),
    open: () => {},
  })
  const target = {
    projectId: activeProject(workspace)!.id,
    workspaceSessionId: activeSession(workspace)!.id,
  }
  const install = (command: string) =>
    backend.newTerminal({ target, directory: "~", launch: { command } })
  const antigravity = () =>
    backend.agents!.state.getSnapshot().find((each) => each.agent === "agy")!
  return { installs, backend, dispatched, install, antigravity, stop }
}

describe("the demo's agent installs", () => {
  it("offer the command that installs an agent that is not there", () => {
    const { antigravity } = started()
    expect(antigravity()).toMatchObject({ available: false, installer: demoInstallers.agy })
  })

  context("when an installer is run in a terminal", () => {
    it("holds the terminal busy, then frees it and shows the agent installed", () => {
      const { install, dispatched, antigravity } = started()
      const terminal = install(demoInstallers.agy)
      expect(terminal).toMatchObject({ state: "running", command: demoInstallers.agy })
      vi.advanceTimersByTime(installMs - 1)
      expect(antigravity().available).toBe(false)
      vi.advanceTimersByTime(1)
      expect(dispatched).toContainEqual(
        expect.objectContaining({
          type: "terminal/status",
          terminalId: terminal.id,
          status: { state: "idle" },
        }),
      )
      expect(antigravity()).toMatchObject({ available: true })
      expect(antigravity()).not.toHaveProperty("installer")
    })

    it("ends in an error once armed to fail, and the agent stays not installed", () => {
      const { installs, install, dispatched, antigravity } = started()
      installs.failNext()
      install(demoInstallers.agy)
      vi.advanceTimersByTime(installMs)
      expect(dispatched).toHaveLength(1)
      expect(antigravity()).toMatchObject({ available: false, installer: demoInstallers.agy })
      // Only that one: the next ends well.
      install(demoInstallers.agy)
      vi.advanceTimersByTime(installMs)
      expect(antigravity().available).toBe(true)
    })

    it("runs until released while held", () => {
      const { installs, install, dispatched, antigravity } = started()
      installs.holdNext()
      install(demoInstallers.agy)
      vi.advanceTimersByTime(installMs * 10)
      expect(dispatched).toEqual([])
      installs.release()
      expect(dispatched).toHaveLength(1)
      expect(antigravity().available).toBe(true)
    })

    it("is a plain terminal for any other command", () => {
      const { install, dispatched } = started()
      expect(install("claude")).toMatchObject({ state: "idle" })
      vi.advanceTimersByTime(installMs)
      expect(dispatched).toEqual([])
    })
  })

  context("when a forge's command is run in a terminal", () => {
    const forge = (backend: ReturnType<typeof started>["backend"], name: string) =>
      backend.forges!.state.getSnapshot().find((each) => each.forge === name)!

    it("plays a sign-in, then shows the host signed in", () => {
      const { install, dispatched, backend } = started()
      const terminal = install(demoSignIn.gitlab)
      expect(terminal).toMatchObject({ state: "running" })
      vi.advanceTimersByTime(installMs - 1)
      expect(forge(backend, "gitlab").hosts[0]!.state).toBe("signed-out")
      vi.advanceTimersByTime(1)
      expect(dispatched).toHaveLength(1)
      expect(forge(backend, "gitlab").hosts[0]!.state).toBe("signed-in")
    })

    it("plays an installer, then shows the forge available, or not where it fails", () => {
      const { installs, install, backend } = started()
      installs.failNext()
      install(demoForgeInstallers.azure!)
      vi.advanceTimersByTime(installMs)
      expect(forge(backend, "azure").available).toBe(false)
      install(demoForgeInstallers.azure!)
      vi.advanceTimersByTime(installMs)
      expect(forge(backend, "azure").available).toBe(true)
    })
  })

  it("show every agent not installed again after a reset", () => {
    const { installs, install, antigravity } = started()
    install(demoInstallers.agy)
    vi.advanceTimersByTime(installMs)
    installs.reset()
    expect(antigravity()).toMatchObject({ available: false, installer: demoInstallers.agy })
  })
})

describe("what an install prints", () => {
  it("ends with the agent's name, or with a network error", () => {
    expect(installReply("claude", "installed")).toContain("claude")
    expect(installReply("claude", "failed")).toBe("curl: (6) Could not resolve host: claude.ai")
  })
})
