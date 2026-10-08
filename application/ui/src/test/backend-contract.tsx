import { act, type ReactNode } from "react"
import { afterEach, vi } from "vitest"

import type {
  Backend,
  BackendAction,
  BackendSink,
  TerminalKey,
  TerminalSurfaceProps,
} from "../backend/port"
import { workspaceFromSeed } from "../model/seed"
import {
  activeProject,
  activeSession,
  workspaceReducer,
  type WorkspaceAction,
} from "../model/state"
import type { TerminalStatus, Workspace, WorkspaceTarget } from "../model/types"
import { context, describe, expect, it } from "../test"
import { render, type Rendered } from "./render"

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
  // Waits for the adapter's asynchronous work to land; defaults to one microtask.
  readonly settle?: () => Promise<void>
}

const microtask = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))

const seeded = (backend: Backend): Workspace =>
  workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 0 })

const commit = (backend: Backend, workspace: Workspace, actions: WorkspaceAction[]): Workspace => {
  const next = actions.reduce(workspaceReducer, workspace)
  backend.commit(next, actions)
  return next
}

const ignore = (): void => {}
// The content alone, with no window around it.
const bare = (content: ReactNode): ReactNode => content
// Two windows of different component types, as two programs' bodies are: switching
// between them remounts the content inside.
const FirstWindow = ({ children }: { readonly children: ReactNode }): React.JSX.Element => (
  <section data-window="first">{children}</section>
)
const SecondWindow = ({ children }: { readonly children: ReactNode }): React.JSX.Element => (
  <article data-window="second">{children}</article>
)
const inFirst = (content: ReactNode): ReactNode => <FirstWindow>{content}</FirstWindow>
const inSecond = (content: ReactNode): ReactNode => <SecondWindow>{content}</SecondWindow>

// Checks the port contract in backend/port.ts against one adapter. Call it from the
// adapter's colocated contract.test.ts.
export const describeBackendContract = (name: string, options: BackendContractOptions): void => {
  const settle = options.settle ?? microtask
  const mounted: Rendered[] = []
  afterEach(() => mounted.splice(0).forEach((surface) => surface.unmount()))

  // A started backend with one terminal the UI just added to the active session.
  const withTerminal = () => {
    const created = options.create()
    const { backend } = created
    const initial = seeded(backend)
    backend.commit(initial, [])
    const project = activeProject(initial)!
    const session = activeSession(initial)!
    const target: WorkspaceTarget = { projectId: project.id, workspaceSessionId: session.id }
    const terminal = backend.newTerminal({ target, directory: project.directory })
    const workspace = commit(backend, initial, [{ type: "terminal/add", target, terminal }])
    const key: TerminalKey = { ...target, terminalId: terminal.id }
    const close = (): Workspace =>
      commit(backend, workspace, [{ type: "terminal/close", target, terminalId: terminal.id }])
    const mount = (props: Partial<TerminalSurfaceProps> = {}) => {
      const { TerminalSurface } = backend
      const element = (next: Partial<TerminalSurfaceProps>) => (
        <TerminalSurface
          terminalKey={key}
          terminal={terminal}
          projectName={project.name}
          fontSize={13}
          focusInput={false}
          onInputFocused={ignore}
          renderWindow={bare}
          {...props}
          {...next}
        />
      )
      const surface = render(element({}))
      mounted.push(surface)
      const root = surface.container.firstElementChild as HTMLElement
      return {
        ...surface,
        root,
        rerender: (next: Partial<TerminalSurfaceProps>) => surface.rerender(element(next)),
      }
    }
    return { ...created, target, terminal, key, workspace, close, mount }
  }

  // Only an adapter with `start` reports on its own, and it must bring a driver to test it.
  const starts = Boolean(options.create().backend.start)

  describe(`${name} backend contract`, () => {
    context("before the app mounts", () => {
      it("supplies a seed the workspace can start from", () => {
        const { backend } = options.create()
        const workspace = seeded(backend)
        expect(activeSession(workspace)).toBeDefined()
      })

      it("starts no I/O when created, even twice", () => {
        const probes = [options.create().probe, options.create().probe]
        expect(probes.map((probe) => probe.io())).toEqual([[], []])
      })

      it("starts no I/O when it sees the initial workspace", async () => {
        const { backend, probe } = options.create()
        backend.commit(seeded(backend), [])
        await settle()
        expect(probe.io()).toEqual([])
      })
    })

    context("when it keeps transcripts", () => {
      it("reports the setting and changes it when asked", async () => {
        const { backend } = options.create()
        if (!backend.transcripts) return
        const { enabled, set } = backend.transcripts
        const changed = vi.fn<() => void>()
        const stop = enabled.subscribe(changed)
        const before = enabled.getSnapshot()
        set(!before)
        await settle()
        expect(enabled.getSnapshot()).toBe(!before)
        expect(changed).toHaveBeenCalled()
        stop()
      })
    })

    context("when the UI creates a terminal", () => {
      it("allocates it synchronously with an id the session does not use", () => {
        const { backend } = options.create()
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

      it("keeps one surface component for the backend's lifetime", () => {
        const { backend } = options.create()
        const surface = backend.TerminalSurface
        const workspace = seeded(backend)
        backend.commit(workspace, [])
        expect(backend.TerminalSurface).toBe(surface)
      })
    })

    context("when its surface renders", () => {
      it("marks the content root for view transitions, layout styles and Canvas", () => {
        const { root } = withTerminal().mount()
        expect(root.hasAttribute("data-terminal-content")).toBe(true)
        expect([...root.classList]).toEqual(
          expect.arrayContaining(["terminal-content", "nodrag", "nopan"]),
        )
        expect(root.hidden).toBe(false)
        expect(root.getAttribute("aria-hidden")).not.toBe("true")
        expect(root.hasAttribute("inert")).toBe(false)
      })

      it("marks exactly one element as the typed input", () => {
        const { root } = withTerminal().mount()
        expect(root.querySelectorAll("[data-terminal-input]")).toHaveLength(1)
      })

      it("keeps plain wheel scrolling to itself and lets zoom gestures through", () => {
        const { root, container } = withTerminal().mount()
        const reached: boolean[] = []
        container.addEventListener("wheel", (event) => reached.push(event.ctrlKey))
        root.dispatchEvent(new WheelEvent("wheel", { bubbles: true }))
        root.dispatchEvent(new WheelEvent("wheel", { bubbles: true, ctrlKey: true }))
        expect(reached).toEqual([true])
      })

      it("focuses its input when asked and reports it", () => {
        const onInputFocused = vi.fn<() => void>()
        const surface = withTerminal().mount({ onInputFocused })
        expect(onInputFocused).not.toHaveBeenCalled()
        surface.rerender({ onInputFocused, focusInput: true })
        expect(document.activeElement).toBe(surface.root.querySelector("[data-terminal-input]"))
        expect(onInputFocused).toHaveBeenCalled()
      })
    })

    context("when the UI wraps its content in a window", () => {
      it("renders its one content element inside the window", () => {
        const { container } = withTerminal().mount({ renderWindow: inFirst })
        const window = container.querySelector("[data-window=first]")!
        expect(window.querySelectorAll("[data-terminal-content]")).toHaveLength(1)
        expect(container.querySelectorAll("[data-terminal-content]")).toHaveLength(1)
      })

      it("keeps the terminal and starts no I/O when the window changes and back", async () => {
        const { probe, key, mount } = withTerminal()
        const surface = mount({ renderWindow: inFirst })
        await act(settle)
        const io = [...probe.io()]
        for (const renderWindow of [inSecond, inFirst]) {
          surface.rerender({ renderWindow })
          // eslint-disable-next-line no-await-in-loop -- Each change settles before the next.
          await act(settle)
          expect(surface.container.querySelectorAll("[data-terminal-content]")).toHaveLength(1)
        }
        expect(probe.holds(key)).toBe(true)
        expect(probe.io()).toEqual(io)
      })
    })

    context("when the UI closes a terminal", () => {
      it("lets go of it and does not repeat the close on later commits", async () => {
        const { backend, probe, key, close } = withTerminal()
        const closed = close()
        await settle()
        expect(probe.holds(key)).toBe(false)
        const io = [...probe.io()]
        backend.commit(closed, [])
        await settle()
        expect(probe.io()).toEqual(io)
      })

      it("ignores input from a surface that was mounted before the close", async () => {
        const { probe, key, close, mount } = withTerminal()
        const { root } = mount()
        await act(async () => {
          close()
          await settle()
        })
        const io = [...probe.io()]
        const errors: unknown[] = []
        const report = (event: ErrorEvent): void => {
          event.preventDefault()
          errors.push(event.error)
        }
        window.addEventListener("error", report)
        try {
          const input = root.querySelector<HTMLElement>("[data-terminal-input]")!
          const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")
          await act(async () => {
            setValue?.set?.call(input, "echo stale")
            input.dispatchEvent(new Event("input", { bubbles: true }))
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
            input
              .closest("form")
              ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
            await settle()
          })
        } finally {
          window.removeEventListener("error", report)
        }
        expect(errors).toEqual([])
        expect(probe.holds(key)).toBe(false)
        expect(probe.io()).toEqual(io)
      })
    })

    context("when the far side reports terminal status", () => {
      it.skipIf(!starts)(
        "delivers each report once through the latest sink and nothing after stop",
        async () => {
          const { backend, driver, key } = withTerminal()
          expect(driver, "an adapter with start needs a driver").toBeDefined()
          const received: { readonly sink: number; readonly action: BackendAction }[] = []
          const sink = (number: number): BackendSink => ({
            dispatch: (actions) =>
              actions.forEach((action) => received.push({ sink: number, action })),
            open: () => {},
          })
          expect(backend.start).toBeTypeOf("function")
          backend.start!(sink(1))()
          const stop = backend.start!(sink(2))
          const exited: TerminalStatus = { state: "exited", exitCode: 3, signal: null }
          await driver!.status(key, exited)
          await settle()
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
          await driver!.status(key, { state: "failed", message: "lost" })
          await settle()
          expect(received).toHaveLength(count)
        },
      )
    })
  })
}
