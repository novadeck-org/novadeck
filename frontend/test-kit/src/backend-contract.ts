import type {
  Backend,
  BackendAction,
  BackendSink,
  TerminalKey,
  TerminalMount,
  TerminalMountProps,
} from "@novadeck/core/port"
import { workspaceFromSeed } from "@novadeck/core/seed"
import {
  activeProject,
  activeSession,
  workspaceReducer,
  type WorkspaceAction,
} from "@novadeck/core/state"
import type { TerminalStatus, Workspace, WorkspaceTarget } from "@novadeck/core/types"
import { act } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "./test"

// What the suite may observe about an adapter without going through the UI.
export type BackendProbe = {
  // Whether the adapter keeps a live terminal for the key.
  readonly holds: (key: TerminalKey) => boolean
  // Every I/O the adapter started so far, such as spawn or kill requests, in order.
  readonly io: () => readonly string[]
}

// Makes the adapter's far side act on its own; only adapters with `start` provide one.
export type BackendDriver = {
  readonly status: (key: TerminalKey, status: TerminalStatus) => void | Promise<void>
}

export type BackendContractOptions = {
  readonly create: () => {
    readonly backend: Backend
    readonly probe: BackendProbe
    readonly driver?: BackendDriver
  }
  // Waits for the backend's asynchronous work to land; defaults to one microtask.
  readonly settle?: (backend: Backend) => Promise<void>
  // How long a screen nobody shows follows its terminal before it parks: the contract waits
  // past it where a wrong release would only show once the screen parks.
  readonly parkMs: number
}

const microtask = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Resolves once the mount draws its terminal's live output.
const liveIn = (mount: TerminalMount): Promise<void> =>
  new Promise((resolve) => {
    const check = (): void => {
      if (!mount.state.getSnapshot().live) return
      stop()
      resolve()
    }
    const stop = mount.state.subscribe(check)
    check()
  })

const seeded = (backend: Backend): Workspace =>
  workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 0 })

const commit = (backend: Backend, workspace: Workspace, actions: WorkspaceAction[]): Workspace => {
  const next = actions.reduce(workspaceReducer, workspace)
  backend.commit(next, actions)
  return next
}

// Runs every step, even after one throws, and throws what they threw once all have run.
const allOf = async (steps: readonly (() => unknown)[], message: string): Promise<void> => {
  const errors: unknown[] = []
  for (const step of steps)
    try {
      // eslint-disable-next-line no-await-in-loop -- Each step may wait on the one before.
      await step()
    } catch (error) {
      errors.push(error)
    }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, message)
}

// Checks the port contract in core/port.ts against one adapter. Call it from the
// adapter's colocated contract.test.ts.
export const describeBackendContract = (name: string, options: BackendContractOptions): void => {
  const settle = options.settle ?? microtask
  // The I/O started so far, once the work already started has landed.
  const settledIo = async (backend: Backend, probe: BackendProbe): Promise<readonly string[]> => {
    await settle(backend)
    return [...probe.io()]
  }

  // What each test made, which the contract lets go of after it: its mounts, then its
  // terminals still open, then the sinks it started.
  const mountings: { readonly mount: TerminalMount; readonly element: HTMLElement }[] = []
  type Made = {
    readonly backend: Backend
    readonly open: Set<() => unknown>
    readonly started: Set<() => void>
  }
  const made: Made[] = []
  const create = (): ReturnType<BackendContractOptions["create"]> & { readonly made: Made } => {
    const created = options.create()
    const entry: Made = { backend: created.backend, open: new Set(), started: new Set() }
    made.push(entry)
    return { ...created, made: entry }
  }
  afterEach(async () => {
    await allOf(
      [
        ...mountings.splice(0).map(({ mount, element }) => () => {
          try {
            mount.dispose()
          } finally {
            element.remove()
          }
        }),
        // Closed while started: a stopped backend may drop a close it is still sending.
        ...made.flatMap((entry) => [...entry.open]),
        ...made.map((entry) => () => settle(entry.backend)),
        ...made.splice(0).flatMap((entry) => [...entry.started]),
      ],
      "the contract's cleanup failed",
    )
  })

  // A started backend with one terminal the UI just added to the active session.
  const withTerminal = () => {
    const created = create()
    const { backend } = created
    let workspace = seeded(backend)
    backend.commit(workspace, [])
    const project = activeProject(workspace)!
    const session = activeSession(workspace)!
    const target: WorkspaceTarget = { projectId: project.id, workspaceSessionId: session.id }
    // Adds a terminal as the UI does; the contract closes it after the test unless the test
    // closed it.
    const add = () => {
      const terminal = backend.newTerminal({ target, directory: project.directory })
      workspace = commit(backend, workspace, [{ type: "terminal/add", target, terminal }])
      const key: TerminalKey = { ...target, terminalId: terminal.id }
      const close = (): Workspace => {
        created.made.open.delete(close)
        return (workspace = commit(backend, workspace, [
          { type: "terminal/close", target, terminalId: terminal.id },
        ]))
      }
      created.made.open.add(close)
      return { terminal, key, close }
    }
    const { terminal, key, close } = add()
    // The terminal mounted into an element in the page, as the UI would, and unmounted after
    // the test.
    const mountInto = (
      props: Partial<TerminalMountProps> = {},
      element = document.body.appendChild(document.createElement("div")),
    ) => {
      let current: TerminalMountProps = {
        name: terminal.name,
        status: terminal.state,
        view: "focus",
        ...props,
      }
      const mount = backend.mountTerminal(element, key, current)
      mountings.push({ mount, element })
      return {
        mount,
        element,
        // Passes the props with `next` changed.
        update: (next: Partial<TerminalMountProps>) =>
          mount.update((current = { ...current, ...next })),
        input: () => element.querySelector<HTMLTextAreaElement>("[data-terminal-input]"),
      }
    }
    // Starts the backend with `sink`; the contract stops it after the test unless the test
    // did.
    const start = (sink: BackendSink): (() => void) => {
      const stop = backend.start!(sink)
      const once = (): void => {
        if (!created.made.started.delete(once)) return
        stop()
      }
      created.made.started.add(once)
      return once
    }
    return { ...created, target, terminal, key, close, add, mountInto, start }
  }

  // What an adapter offers beyond the port's minimum: transcripts, and `start`, with which it
  // reports on its own and must bring a driver to test it.
  const probed = options.create().backend
  const starts = Boolean(probed.start)

  describe(`${name} backend contract`, () => {
    context("before the app mounts", () => {
      it("supplies a seed the workspace can start from", () => {
        const { backend } = create()
        const workspace = seeded(backend)
        expect(activeSession(workspace)).toBeDefined()
      })

      it("starts no I/O when created, even twice", async () => {
        const created = [create(), create()]
        await Promise.all(created.map(({ backend }) => settle(backend)))
        expect(created.map(({ probe }) => probe.io())).toEqual([[], []])
      })

      it("starts no I/O when it sees the initial workspace", async () => {
        const { backend, probe } = create()
        backend.commit(seeded(backend), [])
        await settle(backend)
        expect(probe.io()).toEqual([])
      })
    })

    context("when it keeps transcripts", () => {
      it.skipIf(!probed.transcripts)("reports the setting and changes it when asked", async () => {
        const { backend } = create()
        const { enabled, set } = backend.transcripts!
        const changed = vi.fn<() => void>()
        const stop = enabled.subscribe(changed)
        try {
          const before = enabled.getSnapshot()
          set(!before)
          await settle(backend)
          expect(enabled.getSnapshot()).toBe(!before)
          expect(changed).toHaveBeenCalled()
        } finally {
          stop()
        }
      })
    })

    context("when the UI creates a terminal", () => {
      it("allocates it synchronously with an id the session does not use", () => {
        const { backend } = create()
        const workspace = seeded(backend)
        const session = activeSession(workspace)!
        const terminal = backend.newTerminal({
          target: { projectId: activeProject(workspace)!.id, workspaceSessionId: session.id },
          directory: activeProject(workspace)!.directory,
        })
        expect(terminal).not.toBeInstanceOf(Promise)
        expect(terminal.id).not.toBe("")
        expect(session.state.roster.terminals.map((item) => item.id)).not.toContain(terminal.id)
      })

      it("holds the terminal once the add is committed", () => {
        const { probe, key } = withTerminal()
        expect(probe.holds(key)).toBe(true)
      })

      it("offers telemetry in which a terminal that reported nothing has no entry, closed or not", async () => {
        const { backend, key, close } = withTerminal()
        const held = (): unknown =>
          backend.telemetry.getSnapshot()[`${key.projectId}/${key.workspaceSessionId}`]?.[
            key.terminalId
          ]
        expect(held()).toBeUndefined()
        close()
        await settle(backend)
        expect(held()).toBeUndefined()
      })

      it("keeps its terminal mount for the backend's lifetime, and takes the font", () => {
        const { backend } = create()
        expect(backend.setFont).toBeTypeOf("function")
        const mount = backend.mountTerminal
        backend.commit(seeded(backend), [])
        expect(backend.mountTerminal).toBe(mount)
      })
    })

    // The first mounts the terminal cold, which took 14 s on a busy Windows runner.
    context("when its terminal mounts", { timeout: 30_000 }, () => {
      it("puts exactly one typed input in its element, and none outside it", () => {
        const { element, input } = withTerminal().mountInto()
        expect(element.querySelectorAll("[data-terminal-input]")).toHaveLength(1)
        expect(input()).not.toBeNull()
        expect(document.querySelectorAll("[data-terminal-input]")).toHaveLength(1)
      })

      it("focuses its input when asked, and says so", () => {
        const { mount, input } = withTerminal().mountInto()
        expect(mount.focus()).toBe(true)
        expect(document.activeElement).toBe(input())
      })

      it("names its input with the terminal's name, and follows a new one", () => {
        const { input, update } = withTerminal().mountInto({ name: "Build" })
        expect(input()?.getAttribute("aria-label")).toContain("Build")
        update({ name: "Tests" })
        expect(input()?.getAttribute("aria-label")).toContain("Tests")
        expect(input()?.getAttribute("aria-label")).not.toContain("Build")
      })

      it("tells what is drawn around it as a stable state", () => {
        const { mount } = withTerminal().mountInto()
        const state = mount.state.getSnapshot()
        expect(mount.state.getSnapshot()).toBe(state)
        expect(Object.keys(state).toSorted()).toEqual([
          "live",
          "lock",
          "notice",
          "resuming",
          "waits",
        ])
      })

      it("changes nothing when it is given props equal to its own", async () => {
        const { backend, probe, mountInto } = withTerminal()
        const { mount, element, update } = mountInto()
        const io = await settledIo(backend, probe)
        const woken = vi.fn<() => void>()
        mount.state.subscribe(woken)
        const records: MutationRecord[] = []
        const written = new MutationObserver((batch) => records.push(...batch))
        written.observe(element, {
          subtree: true,
          attributes: true,
          childList: true,
          characterData: true,
        })
        update({})
        update({ view: "focus", onScreen: true })
        await settle(backend)
        records.push(...written.takeRecords())
        written.disconnect()
        expect(records).toEqual([])
        expect(woken).not.toHaveBeenCalled()
        expect(probe.io()).toEqual(io)
      })

      it("starts no I/O when its view changes", async () => {
        const { backend, probe, mountInto } = withTerminal()
        const { update } = mountInto()
        const io = await settledIo(backend, probe)
        for (const view of ["canvas", "focus"] as const) update({ view })
        await settle(backend)
        expect(probe.io()).toEqual(io)
      })

      it("hands its terminal to the next mount within the park window, with no new I/O", async () => {
        const { backend, probe, mountInto } = withTerminal()
        const first = mountInto()
        const io = await settledIo(backend, probe)
        first.mount.dispose()
        const next = document.body.appendChild(document.createElement("div"))
        const second = mountInto({}, next)
        await settle(backend)
        expect(probe.io()).toEqual(io)
        expect(next.querySelectorAll("[data-terminal-input]")).toHaveLength(1)
        expect(first.element.querySelector("[data-terminal-input]")).toBeNull()
        expect(second.input()).not.toBeNull()
      })

      it("lets its screen go and takes it again within the park window, with no new I/O", async () => {
        const { backend, probe, mountInto } = withTerminal()
        const { element, input, update } = mountInto()
        const io = await settledIo(backend, probe)
        update({ onScreen: false })
        update({ onScreen: true })
        await settle(backend)
        expect(probe.io()).toEqual(io)
        expect(element.querySelectorAll("[data-terminal-input]")).toHaveLength(1)
        expect(input()).not.toBeNull()
      })

      it("takes no screen when created off screen, and releases nothing twice when disposed there", async () => {
        const { backend, probe, mountInto } = withTerminal()
        // Another mount shows the terminal throughout: a second release would let go of its
        // hold, and the screen would park under it once the park window passed.
        const shown = mountInto()
        await liveIn(shown.mount)
        const io = await settledIo(backend, probe)
        const { mount, element, update } = mountInto({ onScreen: false })
        await settle(backend)
        expect(probe.io()).toEqual(io)
        expect(element.querySelector("[data-terminal-input]")).toBeNull()
        update({ onScreen: true })
        expect(element.querySelector("[data-terminal-input]")).not.toBeNull()
        update({ onScreen: false })
        mount.dispose()
        mount.dispose()
        await settle(backend)
        // What it last drew stays in its element.
        expect(element.querySelector("[data-terminal-input]")).not.toBeNull()
        await pause(options.parkMs + 500)
        await settle(backend)
        expect(shown.mount.state.getSnapshot().live).toBe(true)
        expect(probe.io()).toEqual(io)
        // A mount now takes the screen the shown one still holds: nothing attaches again.
        mountInto()
        await settle(backend)
        expect(probe.io()).toEqual(io)
      })

      it("can be disposed twice, and is quiet after", () => {
        const { mount } = withTerminal().mountInto()
        mount.dispose()
        expect(() => {
          mount.dispose()
          mount.update({ name: "Late", status: "running", view: "grid" })
          expect(mount.focus()).toBe(false)
          mount.restart()
          mount.state.getSnapshot()
          mount.state.subscribe(() => {})()
        }).not.toThrow()
      })

      it("takes the font before and after it mounts, starting no I/O", async () => {
        const { backend, probe, mountInto } = withTerminal()
        const io = [...probe.io()]
        expect(() => backend.setFont({ size: 15 })).not.toThrow()
        expect(probe.io()).toEqual(io)
        mountInto()
        const mountedIo = await settledIo(backend, probe)
        expect(() => backend.setFont({ size: 12 })).not.toThrow()
        await settle(backend)
        expect(probe.io()).toEqual(mountedIo)
      })

      it("ignores input to a mount made before the UI closed its terminal", async () => {
        const { backend, probe, key, close, mountInto } = withTerminal()
        const { input } = mountInto()
        await act(async () => {
          close()
          await settle(backend)
        })
        const io = [...probe.io()]
        const errors: unknown[] = []
        const report = (event: ErrorEvent): void => {
          event.preventDefault()
          errors.push(event.error)
        }
        window.addEventListener("error", report)
        try {
          const typed = input()!
          const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(typed), "value")
          // Without it nothing would be typed, and the check below would hold trivially.
          expect(setValue?.set).toBeTypeOf("function")
          await act(async () => {
            setValue!.set!.call(typed, "echo stale")
            typed.dispatchEvent(new Event("input", { bubbles: true }))
            typed.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
            await settle(backend)
          })
        } finally {
          window.removeEventListener("error", report)
        }
        expect(errors).toEqual([])
        expect(probe.holds(key)).toBe(false)
        expect(probe.io()).toEqual(io)
      })
    })

    context("when the UI closes a terminal", () => {
      it("lets go of it and does not repeat the close on later commits", async () => {
        const { backend, probe, key, close } = withTerminal()
        const closed = close()
        await settle(backend)
        expect(probe.holds(key)).toBe(false)
        const io = [...probe.io()]
        backend.commit(closed, [])
        await settle(backend)
        expect(probe.io()).toEqual(io)
      })
    })

    // A driver may take a few seconds per report: the runner's shell must have run 2 s.
    context("when the far side reports terminal status", { timeout: 30_000 }, () => {
      it.skipIf(!starts)(
        "delivers each report once through the latest sink and nothing after stop",
        async () => {
          const { backend, driver, key, add, start } = withTerminal()
          // Still running when the backend stops, so a sink left subscribed would hear of it.
          const later = add().key
          expect(driver, "an adapter with start needs a driver").toBeDefined()
          const received: { readonly sink: number; readonly action: BackendAction }[] = []
          const sink = (number: number): BackendSink => ({
            dispatch: (actions) =>
              actions.forEach((action) => received.push({ sink: number, action })),
            open: () => {},
          })
          expect(backend.start).toBeTypeOf("function")
          start(sink(1))()
          const stop = start(sink(2))
          const exited: TerminalStatus = { state: "exited", exitCode: 3, signal: null }
          await driver!.status(key, exited)
          await settle(backend)
          const { terminalId, ...target } = key
          // An adapter may also report what it learns on the way, such as the process running.
          const reports = received.filter(
            ({ action }) =>
              "terminalId" in action &&
              action.terminalId === terminalId &&
              action.type === "terminal/status" &&
              action.status.state === exited.state,
          )
          expect(reports).toEqual([
            { sink: 2, action: { type: "terminal/status", target, terminalId, status: exited } },
          ])
          stop()
          const count = received.length
          // Reported as the first was, which reached the sink then subscribed.
          await driver!.status(later, exited)
          await settle(backend)
          expect(received.slice(count)).toEqual([])
        },
      )
    })
  })
}
