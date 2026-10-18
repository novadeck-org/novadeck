import { act, createElement, useEffect, type ComponentProps } from "react"
import { HashRouter } from "react-router"
import { vi } from "vitest"

import {
  useWorkspaceServices,
  useWorkspaceState,
  type WorkspaceServices,
} from "../app/controller/context"
import { currentState } from "../app/selectors"
import { WorkspaceProvider } from "../app/WorkspaceProvider"
import { WorkspaceTerminal } from "../app/WorkspaceTerminal"
import type { CreateBackend, MountTerminal } from "../backend/port"
import { context, describe, expect, it } from "../test"
import { testPhases } from "../test/phases"
import { render } from "../test/render"
import { createSpecBackend } from "./support/backend"

// jsdom has no layout and no resizes, which the taskbar's drag-to-reorder asks for, and no
// media queries or canvas, which the terminals' emulator falls back without.
vi.hoisted(() => {
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
  HTMLCanvasElement.prototype.getContext = () => null
})

// The second terminal of the demo's storefront.
const second = "storefront-initial-02"
const phases = new WeakMap<HTMLElement, (phase: string) => void>()

const Subject = ({ id }: { id: string }): React.JSX.Element => {
  const terminal = useWorkspaceState((workspace) =>
    currentState(workspace).roster.terminals.find((item) => item.id === id),
  )
  if (!terminal) throw new Error(`Missing terminal ${id}`)
  return createElement(WorkspaceTerminal, { terminal, controls: {} })
}

const Grab = ({ found }: { found: (services: WorkspaceServices) => void }): null => {
  const services = useWorkspaceServices()
  useEffect(() => found(services), [found, services])
  return null
}

const open = async (id: string) => {
  window.location.hash = "#/projects/storefront/sessions/initial/focus"
  const lifecycle = { mounted: 0, unmounted: 0 }
  const phase = testPhases("process windows", () => lifecycle)
  const createBackend: CreateBackend = () => {
    phase("before backend creation")
    const backend = createSpecBackend()
    phase("after backend creation")
    if (!("mountTerminal" in backend)) throw new Error("The spec backend mounts its terminals")
    // Counts the terminal's mounts, which a program starting or ending must not redo.
    const mountTerminal: MountTerminal = (element, key, props) => {
      lifecycle.mounted += 1
      phase("surface mounted")
      const mount = backend.mountTerminal(element, key, props)
      return {
        ...mount,
        dispose: () => {
          lifecycle.unmounted += 1
          mount.dispose()
        },
      }
    }
    return { ...backend, mountTerminal }
  }
  let found!: (services: WorkspaceServices) => void
  const handedOver = new Promise<WorkspaceServices>((resolve) => {
    found = resolve
  })
  phase("before synchronous render")
  const page = render(
    createElement(
      HashRouter,
      null,
      createElement(
        WorkspaceProvider,
        { createBackend } as ComponentProps<typeof WorkspaceProvider>,
        createElement(Grab, { found }),
        createElement(Subject, { id }),
      ),
    ),
  )
  phases.set(page.container, phase)
  phase("after synchronous render")
  const services = await act(() => handedOver)
  phase("after provider act")
  const target = { projectId: "storefront", workspaceSessionId: "initial" }
  const process = (program: string) =>
    act(() => {
      phase(`before process ${program}`)
      services.workspace.dispatch({
        type: "terminal/process",
        target,
        terminalId: id,
        process: program,
      })
      phase(`dispatched process ${program}`)
    })
  const fail = () =>
    act(() => {
      services.workspace.dispatch({
        type: "terminal/status",
        target,
        terminalId: id,
        status: { state: "failed", message: "Could not start" },
      })
    })
  const start = () =>
    act(() => {
      services.workspace.dispatch({
        type: "terminal/status",
        target,
        terminalId: id,
        status: { state: "starting" },
      })
    })
  return { ...page, lifecycle, process, fail, start }
}

const visibleWindow = (container: HTMLElement): HTMLElement => {
  phases.get(container)?.("before window style queries")
  const windows = [...container.querySelectorAll<HTMLElement>("[data-terminal]")].filter(
    (window) =>
      getComputedStyle(window).display !== "none" &&
      getComputedStyle(window.parentElement!).display !== "none",
  )
  expect(windows).toHaveLength(1)
  phases.get(container)?.("after window style queries")
  return windows[0]!
}

// The header icon, which the window's program picks.
const headerIcon = (window: HTMLElement): string | null | undefined =>
  window.querySelector('button[aria-label="Switch terminal"] svg')?.getAttribute("class")

// Types a draft into the header's name field, the way React sees input.
const typeDraft = (field: HTMLInputElement, value: string): void =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value)
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })
const beginHeaderRename = (container: HTMLElement): HTMLInputElement => {
  act(() => {
    visibleWindow(container)
      .querySelector("[data-terminal-name]")!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
  })
  return visibleWindow(container).querySelector<HTMLInputElement>("[data-rename-terminal]")!
}

describe("process windows", () => {
  context("when the foreground process changes", () => {
    it("presents Claude and Codex in the same window and returns to the terminal without remounting the surface", async () => {
      const page = await open(second)
      try {
        const terminal = visibleWindow(page.container)
        expect(terminal.querySelector("[data-terminal-input]")).not.toBeNull()
        // The switcher keeps the button it opened from.
        const switcher = terminal.querySelector('button[aria-label="Switch terminal"]')

        page.process("claude")
        expect(visibleWindow(page.container).dataset.processWindow).toBe("claude")
        expect(visibleWindow(page.container).querySelector("[data-terminal-input]")).not.toBeNull()
        expect(visibleWindow(page.container).querySelector(".terminal-header")).not.toBeNull()
        expect(headerIcon(visibleWindow(page.container))).toContain("lucide-claude")

        page.process("codex")
        expect(visibleWindow(page.container).dataset.processWindow).toBe("codex")
        expect(visibleWindow(page.container).querySelector("[data-terminal-input]")).not.toBeNull()

        page.process("zsh")
        expect(visibleWindow(page.container)).toBe(terminal)
        expect(terminal.querySelector('button[aria-label="Switch terminal"]')).toBe(switcher)
        expect(visibleWindow(page.container).dataset.processWindow).toBeUndefined()
        expect(headerIcon(visibleWindow(page.container))).toContain("lucide-terminal")
        expect(visibleWindow(page.container).querySelector("[data-terminal-input]")).not.toBeNull()
        expect(page.lifecycle).toEqual({ mounted: 1, unmounted: 0 })
      } finally {
        page.unmount()
      }
    })

    it("keeps other programs in the plain terminal window", async () => {
      const page = await open(second)
      try {
        const terminal = visibleWindow(page.container)
        page.process("vim")
        expect(visibleWindow(page.container)).toBe(terminal)
        expect(page.lifecycle).toEqual({ mounted: 1, unmounted: 0 })
      } finally {
        page.unmount()
      }
    })

    it("shows the regular terminal again when an agent session fails", async () => {
      const page = await open(second)
      try {
        page.process("claude")
        expect(visibleWindow(page.container).dataset.processWindow).toBe("claude")

        page.fail()
        expect(visibleWindow(page.container).dataset.processWindow).toBeUndefined()
        expect(page.lifecycle).toEqual({ mounted: 1, unmounted: 0 })
      } finally {
        page.unmount()
      }
    })

    it("shows the terminal during a fresh shell startup even while the last program is an agent", async () => {
      const page = await open(second)
      try {
        page.process("codex")
        expect(visibleWindow(page.container).dataset.processWindow).toBe("codex")

        page.start()
        expect(visibleWindow(page.container).dataset.processWindow).toBeUndefined()
        expect(page.lifecycle).toEqual({ mounted: 1, unmounted: 0 })
      } finally {
        page.unmount()
      }
    })
  })

  context("while the terminal is being renamed", () => {
    it("keeps the header's draft, caret and focus when a program starts and ends", async () => {
      const page = await open(second)
      try {
        const field = beginHeaderRename(page.container)
        typeDraft(field, "My new na")
        field.setSelectionRange(9, 9)
        expect(document.activeElement).toBe(field)

        for (const program of ["claude", "codex", "zsh"]) {
          page.process(program)
          const current = visibleWindow(page.container).querySelector("[data-rename-terminal]")
          expect(current).toBe(field)
          expect([field.value, field.selectionStart, field.selectionEnd]).toEqual([
            "My new na",
            9,
            9,
          ])
          expect(document.activeElement).toBe(field)
        }
      } finally {
        page.unmount()
      }
    })

    it("leaves focus in another rename field when a program starts", async () => {
      const page = await open(second)
      // Stands in for the sidebar's field, which continues the same rename.
      const sidebar = document.createElement("input")
      sidebar.dataset.renameTerminal = second
      document.body.append(sidebar)
      try {
        const header = beginHeaderRename(page.container)
        act(() => sidebar.focus())
        page.process("claude")
        expect(visibleWindow(page.container).querySelector("[data-rename-terminal]")).toBe(header)
        expect(document.activeElement).toBe(sidebar)
      } finally {
        sidebar.remove()
        page.unmount()
      }
    })
  })
})
