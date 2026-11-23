import { workspaceFromSeed } from "@novadeck/core/seed"
import { createTerminalState, workspaceReducer, type WorkspaceAction } from "@novadeck/core/state"
import type { WorkspaceTarget } from "@novadeck/core/types"
import type { TerminalEvent } from "@novadeck/protocol"
import type { AttachedTerminal, Runner } from "@novadeck/runner-client"
import { noTheme } from "@novadeck/terminal-views/theme"
import { afterAll, vi } from "vitest"

import { runnerBackend, type RunnerApi } from "./backend"
import { describe, expect, it } from "./test"
import { startTestRunner } from "./testing/runner"

// jsdom has no layout observers, media queries or canvas; xterm falls back without them.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  })
})
vi.setConfig({ testTimeout: 30_000 })

const runner = await startTestRunner()
afterAll(() => runner.close())

// An attachment another client controls, which lets this one take control.
const observing = () => {
  const events: TerminalEvent[] = [
    { terminalId: "t", sequence: 1, type: "snapshot", cols: 90, rows: 20, data: "$ ", exit: null },
  ]
  let mode: "control" | "observe" = "observe"
  const listeners = new Set<(mode: "control" | "observe") => void>()
  const written: string[] = []
  const resized: unknown[] = []
  const taken: unknown[] = []
  const attached: AttachedTerminal = {
    id: "t",
    get mode() {
      return mode
    },
    onMode: (listener: (mode: "control" | "observe") => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    take: async (options?: unknown) => {
      taken.push(options)
      mode = "control"
      listeners.forEach((listener) => listener(mode))
    },
    [Symbol.asyncIterator]: () => attached,
    next: async () => {
      const next = events.shift()
      return next
        ? { value: next, done: false as const }
        : await new Promise<IteratorResult<TerminalEvent>>(() => {})
    },
    return: async () => ({ value: undefined, done: true as const }),
    write: async (data: string) => void written.push(data),
    resize: async (size: unknown) => void resized.push(size),
    detach: async () => {},
  }
  return { attached, written, resized, taken }
}

describe("a second client on a runner that supports controls", () => {
  it("attaches taking control where free, else observing, and shows the strip, whatever the windows setting", async () => {
    const fake = observing()
    const asked: unknown[] = []
    // Project windows are off (no project is ever shown to the backend), and no desktop bridge
    // exists in this page: nothing but the runner's support decides.
    const api: RunnerApi = Object.assign(Object.create(runner.client) as Runner, {
      supports: () => true,
      terminals: Object.assign(Object.create(runner.client.terminals) as Runner["terminals"], {
        attach: async (_id: string, options?: unknown) => {
          asked.push(options)
          return fake.attached
        },
      }),
    })
    const { backend } = runnerBackend(api, runner.listing, { saveDelay: 10, theme: noTheme })
    let workspace = workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 1 })
    backend.commit(workspace, [])
    const commit = (actions: WorkspaceAction[]) => {
      workspace = actions.reduce(workspaceReducer, workspace)
      backend.commit(workspace, actions)
    }
    const stop = backend.start!({ dispatch: (actions) => commit([...actions]), open: () => {} })
    const project = { id: crypto.randomUUID(), name: "tmp", directory: process.cwd() }
    const session = {
      id: crypto.randomUUID(),
      name: "First",
      visitedAt: Date.now(),
      state: createTerminalState([], "grid", "grid"),
    }
    commit([{ type: "project/add", project, activate: true, initialSession: session }])
    const target: WorkspaceTarget = { projectId: project.id, workspaceSessionId: session.id }
    const terminal = backend.newTerminal({ target, directory: project.directory })
    commit([{ type: "terminal/add", target, terminal }])

    const container = document.createElement("div")
    document.body.append(container)
    const mount = backend.mountTerminal(
      container,
      { ...target, terminalId: terminal.id },
      { name: "t", status: "running", view: "grid" },
    )
    await vi.waitFor(() => expect(asked).toEqual([{ mode: "control-else-observe" }]), {
      timeout: 10_000,
    })
    await vi.waitFor(() => expect(mount.state.getSnapshot().control).toBe("observing"))
    await vi.waitFor(() => expect(mount.state.getSnapshot().lock).toBeNull())
    expect(fake.resized).toEqual([])

    // The strip's button takes control.
    mount.take?.()
    await vi.waitFor(() => expect(mount.state.getSnapshot().control ?? null).toBeNull())
    expect(fake.taken.length).toBeGreaterThan(0)

    mount.dispose()
    container.remove()
    stop()
  })
})
