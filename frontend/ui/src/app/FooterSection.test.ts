import { createTelemetryStore } from "@novadeck/core/agents/telemetry"
import type { UpdateOffer } from "@novadeck/core/desktop/update"
import type { Backend } from "@novadeck/core/port"
import { workspaceFixture } from "@novadeck/core/testing"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import { render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { openCommands } from "../test/commands"
import { WorkspaceServicesContext } from "./controller/context"
import { FooterSection } from "./FooterSection"
import { noLanding } from "./inbox-landing"

const mounted: Rendered[] = []
afterEach(() => {
  mounted.splice(0).forEach((page) => page.unmount())
  vi.useRealTimers()
  localStorage.clear()
})

// The footer over real stores, with a backend that has only what the test gives it.
const show = (backend: Partial<Backend>, workspace?: Workspace): Rendered =>
  shown(backend, workspace).page
const shown = (backend: Partial<Backend>, workspace?: Workspace) => {
  const { context, commands, ui } = openCommands(workspace ? { workspace } : {})
  const page = render(
    createElement(
      WorkspaceServicesContext,
      {
        value: {
          backend: { telemetry: createTelemetryStore(), ...backend } as Backend,
          workspace: context.workspace,
          ui: context.ui,
          chat: context.chat,
          navigation: context.navigation,
          commands,
          canvas: { current: null },
          itemStore: undefined,
          landing: noLanding,
          drag: undefined as never,
        },
      },
      createElement(FooterSection),
    ),
  )
  mounted.push(page)
  return { page, ui }
}

const feedback: NonNullable<Backend["feedback"]> = {
  about: () => Promise.resolve({ version: "0.0.1", os: "Linux x64" }),
  send: () => Promise.resolve(),
  ask: () => Promise.resolve(),
}

describe("the footer's feedback button", () => {
  it("is there only where the backend takes feedback", () => {
    expect(show({}).container.querySelector(".feedback-button")).toBeNull()
    expect(show({ feedback }).container.querySelector(".feedback-button")).not.toBeNull()
  })
})

describe("the footer's restart to update chip", () => {
  const ready: UpdateOffer = { kind: "ready", version: "0.0.81" }
  const updates = (restart?: () => void): NonNullable<Backend["updates"]> => ({
    onOffer: () => () => {},
    openPage: () => {},
    ...(restart ? { restart } : {}),
  })
  const chipOf = (page: Rendered) =>
    [...page.container.querySelectorAll("button")].find((button) =>
      button.getAttribute("aria-label")?.startsWith("Restart to update"),
    )
  // The footer with the offer the desktop app last said, the way the app's effects store it.
  const withOffer = (
    backend: Partial<Backend>,
    offer: UpdateOffer | null,
    portable: ReturnType<typeof initialPortable> | null = null,
    workspace?: Workspace,
  ) => {
    const { page, ui } = shown(backend, workspace)
    act(() => ui.update((state) => ({ ...state, update: offer, portable })))
    return page
  }
  const initialPortable = () => ({
    portable: true as const,
    version: "0.0.1",
    run: "run",
    install: { phase: "idle" as const },
  })

  it("is there for a ready update an app that can restart gives", () => {
    expect(chipOf(withOffer({ updates: updates(() => {}) }, ready))).toBeDefined()
  })

  it("is not there without the app's restart, an update that isn't ready, or any update", () => {
    expect(chipOf(withOffer({ updates: updates() }, ready))).toBeUndefined()
    expect(chipOf(withOffer({}, ready))).toBeUndefined()
    const restart = { updates: updates(() => {}) }
    expect(
      chipOf(withOffer(restart, { kind: "downloading", version: "0.0.81", percent: 5 })),
    ).toBeUndefined()
    expect(chipOf(withOffer(restart, { kind: "available", version: "0.0.81" }))).toBeUndefined()
    expect(chipOf(withOffer(restart, null))).toBeUndefined()
  })

  it("is not there on a portable copy, which has its own chip, nor while that is unknown", () => {
    const portable = { state: () => Promise.resolve({ portable: false as const }) }
    const backend = { updates: updates(() => {}), portable } as unknown as Partial<Backend>
    expect(chipOf(withOffer(backend, ready, initialPortable()))).toBeUndefined()
    // The desktop app has not yet said whether this is a portable copy.
    expect(chipOf(withOffer(backend, ready, null))).toBeUndefined()
  })

  describe("its card", () => {
    const terminal = (id: string, name: string, over: Partial<TerminalMetadata> = {}) =>
      ({
        ...workspaceFixture().projects[0]!.history[0]!.state.roster.terminals[0]!,
        id,
        name,
        ...over,
      }) as TerminalMetadata
    // Two projects of two sessions: the card counts every one, not only the session on screen.
    const spread = (): Workspace => {
      const base = workspaceFixture({ sessions: ["a", "b"], terminals: 1 })
      const [project] = base.projects
      const sessions = (prefix: string, extra: TerminalMetadata[]) =>
        project!.history.map((session, index) => ({
          ...session,
          id: `${prefix}${session.id}`,
          state: {
            ...session.state,
            roster: {
              ...session.state.roster,
              terminals: [
                terminal(`${prefix}${index}`, `Shell ${prefix}${index}`),
                ...(index === 1 ? extra : []),
              ],
            },
          },
        }))
      return {
        activeProjectId: "project",
        projects: [
          {
            ...project!,
            activeSessionId: "aa",
            history: sessions("a", [
              terminal("dev", "Dev server", { process: "vite", state: "running" }),
            ]),
          },
          {
            ...project!,
            id: "other",
            activeSessionId: "ba",
            history: sessions("b", [
              terminal("api", "Api", {
                process: "node",
                argv: ["node", "pnpm.cjs", "dev"],
                state: "running",
              }),
            ]),
          },
        ],
      }
    }

    it("counts every session of every project, and names what stops in any of them", () => {
      const page = withOffer({ updates: updates(() => {}) }, ready, null, spread())
      act(() => chipOf(page)!.click())
      const card = page.container.querySelector(".restart-card")!
      expect(card.querySelector(".restart-count")?.textContent).toBe("4 reopen")
      expect(card.textContent).toContain("vite stops")
      expect(card.textContent).toContain("pnpm dev stops")
    })

    it("asks the runner about shells only while it shows, and again every few seconds", async () => {
      vi.useFakeTimers()
      const busyTerminals = vi.fn<NonNullable<Backend["busyTerminals"]>>(() =>
        Promise.resolve({ busy: [], unknown: [] }),
      )
      const page = withOffer({ updates: updates(() => {}), busyTerminals }, ready)
      await act(() => vi.advanceTimersByTimeAsync(20_000))
      expect(busyTerminals).not.toHaveBeenCalled()
      await act(async () => chipOf(page)!.click())
      expect(busyTerminals).toHaveBeenCalledOnce()
      await act(() => vi.advanceTimersByTimeAsync(5_000))
      expect(busyTerminals).toHaveBeenCalledTimes(2)
      act(() => (page.container.querySelector(".update-card-close") as HTMLElement).click())
      await act(() => vi.advanceTimersByTimeAsync(30_000))
      expect(busyTerminals).toHaveBeenCalledTimes(2)
    })

    it("names a shell with a job the runner sees, and claims nothing before it answers", async () => {
      let answer: (told: { busy: string[]; unknown: string[] }) => void = () => {}
      const busyTerminals = () =>
        new Promise<{ busy: string[]; unknown: string[] }>((resolve) => (answer = resolve))
      const page = withOffer({ updates: updates(() => {}), busyTerminals }, ready)
      await act(async () => chipOf(page)!.click())
      const verdict = () => page.container.querySelector(".restart-verdict")?.textContent
      expect(verdict()).toBe("Checking what a restart keeps…")
      await act(async () => answer({ busy: ["01"], unknown: [] }))
      expect(verdict()).toBe("Almost everything comes back")
      expect(page.container.querySelector(".restart-card")?.textContent).toContain(
        "Can't see what runs",
      )
    })

    it("asks once more as Restart now is pressed, and holds back for work the card didn't show", async () => {
      const restart = vi.fn<() => void>()
      const answers = [
        { busy: [], unknown: [] },
        { busy: ["01"], unknown: [] },
      ]
      const busyTerminals = vi.fn<NonNullable<Backend["busyTerminals"]>>(() =>
        Promise.resolve(answers.shift()),
      )
      const page = withOffer({ updates: updates(restart), busyTerminals }, ready)
      await act(async () => chipOf(page)!.click())
      const restartNow = () =>
        [...page.container.querySelectorAll("button")].find(
          (button) => button.textContent === "Restart now",
        )!
      await act(async () => restartNow().click())
      expect(restart).not.toHaveBeenCalled()
      const card = page.container.querySelector(".restart-card")!
      expect(card.querySelector(".restart-verdict")?.textContent).toBe(
        "Almost everything comes back",
      )
      // Pressed again with nothing new, it goes on.
      busyTerminals.mockResolvedValueOnce({ busy: ["01"], unknown: [] })
      await act(async () => restartNow().click())
      expect(restart).toHaveBeenCalledOnce()
    })

    it("restarts as before where the second look fails, the card having shown what it could", async () => {
      const restart = vi.fn<() => void>()
      const busyTerminals = vi
        .fn<NonNullable<Backend["busyTerminals"]>>()
        .mockResolvedValueOnce({ busy: [], unknown: [] })
        .mockResolvedValue(undefined)
      const page = withOffer({ updates: updates(restart), busyTerminals }, ready)
      await act(async () => chipOf(page)!.click())
      await act(async () =>
        [...page.container.querySelectorAll("button")]
          .find((button) => button.textContent === "Restart now")!
          .click(),
      )
      expect(restart).toHaveBeenCalledOnce()
    })

    it("says it couldn't check where the runner can't answer", async () => {
      const busyTerminals = () => Promise.resolve(undefined)
      const page = withOffer({ updates: updates(() => {}), busyTerminals }, ready)
      await act(async () => chipOf(page)!.click())
      expect(page.container.querySelector(".restart-card")?.textContent).toContain(
        "Couldn't check what runs in shells",
      )
    })
  })
})
