import {
  act,
  createElement,
  StrictMode,
  useEffect,
  type ComponentProps,
  type ComponentType,
} from "react"
import { HashRouter } from "react-router"
import { afterEach, beforeAll, vi } from "vitest"

import { createTelemetryStore, setUsage, type TelemetryStore } from "#core/telemetry"
import type { AgentUsage } from "#core/types"

import { createSpecBackend } from "../backend/demo/spec-variants"
import { context, describe, expect, it } from "../test"
import { itemFixture } from "../test/fixtures"
import { testPhases } from "../test/phases"
import { render } from "../test/render"
import { WorkspaceApp } from "./App"
import { useWorkspaceServices, type WorkspaceServices } from "./controller/context"
import { WorkspaceProvider } from "./WorkspaceProvider"

// jsdom has no layout: a desktop-wide window without motion preferences, and no resizes.
vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("min-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  })
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

// Renders counted per component, and per terminal for tabs and frames. Each mock wraps
// a props-only component, which renders exactly when the section above it does.
const { renders, counted } = vi.hoisted(() => {
  const counts = new Map<string, number>()
  const wrap = async <P extends object>(
    name: string,
    Component: ComponentType<P>,
    id?: (props: P) => string,
  ) => {
    const { createElement: element } = await import("react")
    return (props: P) => {
      const key = id ? `${name} ${id(props)}` : name
      counts.set(key, (counts.get(key) ?? 0) + 1)
      return element(Component, props)
    }
  }
  return { renders: counts, counted: wrap }
})

vi.mock("../shell/WorkspaceHeader", async (original) => {
  const actual = await original<typeof import("../shell/WorkspaceHeader")>()
  return { ...actual, WorkspaceHeader: await counted("header", actual.WorkspaceHeader) }
})
vi.mock("../shell/WorkspaceSidebar", async (original) => {
  const actual = await original<typeof import("../shell/WorkspaceSidebar")>()
  return { ...actual, WorkspaceSidebar: await counted("sidebar", actual.WorkspaceSidebar) }
})
vi.mock("../shell/WorkspacePanels", async (original) => {
  const actual = await original<typeof import("../shell/WorkspacePanels")>()
  return { ...actual, WorkspacePanels: await counted("app", actual.WorkspacePanels) }
})
vi.mock("../layouts/canvas/Canvas", async (original) => {
  const actual = await original<typeof import("../layouts/canvas/Canvas")>()
  return { ...actual, Canvas: await counted("stage", actual.Canvas) }
})
vi.mock("../terminals/TerminalTab", async (original) => {
  const actual = await original<typeof import("../terminals/TerminalTab")>()
  return {
    ...actual,
    TerminalTab: await counted("tab", actual.TerminalTab, (props) => props.terminal.id),
  }
})
vi.mock("../terminals/WindowShell", async (original) => {
  const actual = await original<typeof import("../terminals/WindowShell")>()
  return {
    ...actual,
    WindowShell: await counted("frame", actual.WindowShell, (props) => props.terminal.id),
  }
})
vi.mock("../terminals/WindowStats", async (original) => {
  const actual = await original<typeof import("../terminals/WindowStats")>()
  return {
    ...actual,
    WindowStats: await counted("stats", actual.WindowStats, (props) => props.stats.model ?? ""),
  }
})
vi.mock("../search/TerminalSearch", async (original) => {
  const actual = await original<typeof import("../search/TerminalSearch")>()
  return { ...actual, TerminalSearch: await counted("overlays", actual.TerminalSearch) }
})

// The demo's first two terminals of the storefront.
const first = "storefront-initial-01"
const second = "storefront-initial-02"

// Rendering the whole page in jsdom is slow on small CI runners, Windows in particular.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

// The mocks above wait on the real module, and a second import from the same module that
// arrives meanwhile is answered with the real one, unmocked. Slowly loading runners hit that
// when the page imports Canvas on demand twice at once, and Canvas then goes uncounted. Load
// them once here, alone, so every later import gets the mock.
beforeAll(async () => {
  await import("../layouts/canvas/Canvas")
  await import("../search/TerminalSearch")
})

const mounted = new Set<{ unmount: () => void }>()
afterEach(() => {
  // Unmount even when a test fails, so no page outlives its test.
  mounted.forEach((page) => page.unmount())
  mounted.clear()
})

// Hands the test the services the provider created.
const Grab = ({ found }: { readonly found: (services: WorkspaceServices) => void }): null => {
  const services = useWorkspaceServices()
  useEffect(() => found(services), [found, services])
  return null
}

// The whole workspace page over the default backend, or the one given, with its services
// in reach.
const open = async (createBackend = createSpecBackend) => {
  const phase = testPhases("workspace render scope", () => Object.fromEntries(renders))
  window.location.hash = `#/projects/storefront/sessions/initial/canvas?terminal=${first}`
  let found!: (services: WorkspaceServices) => void
  const handedOver = new Promise<WorkspaceServices>((resolve) => {
    found = resolve
  })
  // StrictMode, as main.tsx renders it: each render counts twice.
  phase("before synchronous render")
  const page = render(
    createElement(
      StrictMode,
      null,
      createElement(
        HashRouter,
        null,
        createElement(
          WorkspaceProvider,
          // The children follow as arguments.
          { createBackend } as ComponentProps<typeof WorkspaceProvider>,
          createElement(Grab, { found }),
          createElement(WorkspaceApp),
        ),
      ),
    ),
  )
  phase("after synchronous render")
  mounted.add(page)
  // Canvas and search load on demand; wait until they have and the provider handed over.
  const services = await act(async () => {
    phase("before Canvas import")
    await import("../layouts/canvas/Canvas")
    phase("after Canvas import")
    await import("../search/TerminalSearch")
    phase("after Search import")
    const handed = await handedOver
    phase("provider handed over")
    return handed
  })
  phase("after async act")
  return { page, services }
}

// What rendered while `change` ran, by component.
const rendersDuring = (change: () => void): Record<string, number> => {
  renders.clear()
  act(change)
  return Object.fromEntries(renders)
}

const firstTarget = (services: WorkspaceServices) => {
  const { activeProjectId, projects } = services.workspace.getSnapshot()
  const project = projects.find((item) => item.id === activeProjectId)!
  return { projectId: project.id, workspaceSessionId: project.activeSessionId }
}

describe("workspace render scope", () => {
  context("when the page first renders", () => {
    it("renders every section", async () => {
      renders.clear()
      await open()
      expect([...renders.keys()]).toEqual(
        expect.arrayContaining([
          "app",
          "header",
          "sidebar",
          "stage",
          "overlays",
          `tab ${second}`,
          `frame ${second}`,
        ]),
      )
    })
  })

  // "stage" counts Canvas, which renders exactly when WorkspaceStage does.
  context("when Canvas saves its layout", () => {
    it("re-renders only the stage, Canvas and the terminals on it", async () => {
      const { services } = await open()
      const seen = rendersDuring(() =>
        services.commands.setCanvasLayout(firstTarget(services), (layout) => ({
          ...layout,
          viewport: { x: 10, y: 20, zoom: 1 },
        })),
      )
      const frames = Object.keys(seen).filter((name) => name.startsWith("frame "))
      expect(frames.length).toBeGreaterThan(0)
      expect(new Set(Object.keys(seen))).toEqual(new Set(["stage", ...frames]))
    })
  })

  context("when a rename keystroke changes the draft", () => {
    it("re-renders only the tab and the frame of the terminal being renamed", async () => {
      const { services } = await open()
      const terminal = services.workspace
        .getSnapshot()
        .projects.flatMap((project) => project.history)
        .flatMap((session) => session.state.roster.terminals)
        .find((item) => item.id === second)!
      act(() => services.commands.startRename(terminal, "sidebar"))
      const seen = rendersDuring(() => services.commands.changeRenameDraft(second, "Server"))
      expect(seen).toEqual({ [`tab ${second}`]: 2, [`frame ${second}`]: 2 })
    })
  })

  context("when something on one terminal's bar is shown again", () => {
    it("re-renders only that terminal's frame and its tab, which shows its bar", async () => {
      const { services } = await open()
      const target = firstTarget(services)
      const mine = itemFixture("mine", first)
      const theirs = itemFixture("theirs", second)
      act(() =>
        services.workspace.transact([
          { type: "item/upsert", target, item: mine },
          { type: "item/upsert", target, item: theirs },
          { type: "bar/open", target, terminalId: first, key: mine.id },
          { type: "bar/close", target, terminalId: first },
        ]),
      )
      const seen = rendersDuring(() =>
        services.workspace.dispatch({
          type: "item/upsert",
          target,
          item: { ...mine, version: 2 },
        }),
      )
      expect(seen).toEqual({ [`frame ${first}`]: 2, [`tab ${first}`]: 2 })
    })
  })

  context("when an agent's status line reports how full its context is", () => {
    // Each terminal's agent runs on its own model, which names its stats.
    const usage = (model: string, occupied: number): AgentUsage => ({
      context: { occupied, capacity: 200_000 },
      limits: [],
      model,
      effort: null,
    })
    // The telemetry, telling which of its readers each report wakes: a terminal's by its
    // id, and the whole of it as "whole".
    const watched = (woken: string[]): TelemetryStore => {
      const telemetry = createTelemetryStore()
      return {
        ...telemetry,
        subscribe: (listener) => telemetry.subscribe(() => (woken.push("whole"), listener())),
        entry: (key) => {
          const entry = telemetry.entry(key)
          return {
            getSnapshot: entry.getSnapshot,
            subscribe: (listener) =>
              entry.subscribe(() => (woken.push(key.terminalId), listener())),
          }
        },
      }
    }

    it("re-renders only that terminal's stats, and wakes only its reader", async () => {
      const woken: string[] = []
      const telemetry = watched(woken)
      const { services } = await open(() => ({ ...createSpecBackend(), telemetry }))
      const target = firstTarget(services)
      const session = `${target.projectId}/${target.workspaceSessionId}`
      act(() =>
        services.workspace.transact(
          [first, second].map((terminalId) => ({
            type: "terminal/status" as const,
            target,
            terminalId,
            status: { state: "running" as const, agent: { working: true } },
          })),
        ),
      )
      act(() =>
        telemetry.update((held) =>
          setUsage(
            setUsage(held, session, first, usage("a", 1_000)),
            session,
            second,
            usage("b", 1_000),
          ),
        ),
      )
      woken.length = 0
      const seen = rendersDuring(() =>
        telemetry.update((held) => setUsage(held, session, first, usage("a", 2_000))),
      )
      expect(seen).toEqual({ "stats a": 2 })
      // The footer, which reads the whole of it for the subscriptions, and that terminal's
      // window: no other window's reader.
      expect(woken.toSorted()).toEqual([first, "whole"].toSorted())
    })
  })
})
