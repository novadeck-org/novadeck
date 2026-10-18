import { act, createElement, type ReactNode } from "react"
import { vi, type Mock } from "vitest"

import type {
  MountTerminal,
  TerminalKey,
  TerminalMount,
  TerminalMountProps,
  ViewState,
} from "#core/port"
import { createStore } from "#core/store"
import type { TerminalMetadata, ViewMode } from "#core/types"

import { context, describe, expect, it } from "../test"
import { terminalFixture } from "../test/fixtures"
import { render } from "../test/render"
import { MountedTerminal } from "./MountedTerminal"

const key: TerminalKey = { projectId: "p", workspaceSessionId: "s", terminalId: "01" }
const open: ViewState = { live: true, resuming: false, waits: false, lock: null, notice: null }
const running = (): TerminalMetadata => ({ ...terminalFixture(1, "~"), state: "running" })

// A mount whose methods record their calls.
type Mocked = {
  readonly state: TerminalMount["state"]
  readonly update: Mock<TerminalMount["update"]>
  readonly focus: Mock<TerminalMount["focus"]>
  readonly restart: Mock<TerminalMount["restart"]>
  readonly dispose: Mock<TerminalMount["dispose"]>
}

// A mount that draws one input and records what the UI asks of it. `landing` says whether
// its focus lands; `state` is what it tells.
const stub = () => {
  const state = createStore<ViewState>(open)
  const created: { element: HTMLElement; key: TerminalKey; props: TerminalMountProps }[] = []
  const mounts: Mocked[] = []
  const log = { disposedInPage: [] as boolean[] }
  const landing = { value: true }
  const mountTerminal: MountTerminal = (element, mountKey, props) => {
    created.push({ element, key: mountKey, props })
    // Focus lands only while the mount is on screen, as a real one's does.
    let shown = props.onScreen !== false
    const field = document.createElement("textarea")
    field.setAttribute("data-terminal-input", "")
    element.replaceChildren(field)
    const mount: Mocked = {
      state,
      update: vi.fn<TerminalMount["update"]>((next) => void (shown = next.onScreen !== false)),
      focus: vi.fn<TerminalMount["focus"]>(() => {
        if (!landing.value || !shown) return false
        field.focus()
        return true
      }),
      restart: vi.fn<TerminalMount["restart"]>(),
      dispose: vi.fn<TerminalMount["dispose"]>(
        () => void log.disposedInPage.push(element.isConnected),
      ),
    }
    mounts.push(mount)
    return mount
  }
  return { state, created, mounts, mountTerminal, log, landing }
}

type Options = {
  readonly terminal?: TerminalMetadata
  readonly view?: ViewMode
  readonly focusInput?: boolean
  readonly onInputFocused?: () => void
  readonly onScreen?: boolean
  readonly terminalKey?: TerminalKey
  readonly renderWindow?: (content: ReactNode) => ReactNode
}
const bare = (content: ReactNode): ReactNode => content
const First = ({ children }: { children: ReactNode }) =>
  createElement("section", { "data-window": "first" }, children)
const Second = ({ children }: { children: ReactNode }) =>
  createElement("article", { "data-window": "second" }, children)
const inFirst = (content: ReactNode): ReactNode => createElement(First, null, content)
const inSecond = (content: ReactNode): ReactNode => createElement(Second, null, content)
const onInputFocused = (): void => {}

const hosted = (mountTerminal: MountTerminal, options: Options = {}) =>
  createElement(MountedTerminal, {
    mountTerminal,
    terminalKey: options.terminalKey ?? key,
    terminal: options.terminal ?? running(),
    view: options.view ?? "focus",
    focusInput: options.focusInput ?? false,
    onInputFocused: options.onInputFocused ?? onInputFocused,
    onScreen: options.onScreen ?? true,
    renderWindow: options.renderWindow ?? bare,
  })

const show = (options: Options = {}) => {
  const fake = stub()
  let current = options
  const page = render(hosted(fake.mountTerminal, current))
  const change = (next: Options) =>
    page.rerender(hosted(fake.mountTerminal, (current = { ...current, ...next })))
  return { ...fake, ...page, change }
}
const content = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-terminal-content]")!

describe("a terminal drawn by a backend's mount", () => {
  context("when it mounts", () => {
    it("gives the mount one element, kept for the terminal's life, and mounts once", () => {
      const { created, container, change, mounts } = show()
      expect(created).toHaveLength(1)
      const { element, props } = created[0]!
      expect(container.contains(element)).toBe(true)
      expect(props).toEqual({ name: "Terminal", status: "running", view: "focus", onScreen: true })
      change({ view: "grid" })
      change({ renderWindow: inFirst })
      expect(created).toHaveLength(1)
      expect(mounts[0]!.update).toHaveBeenLastCalledWith({
        name: "Terminal",
        status: "running",
        view: "grid",
        onScreen: true,
      })
    })

    it("marks the content root for view transitions, layout styles and Canvas", () => {
      const { container } = show()
      const root = content(container)
      expect([...root.classList]).toEqual(
        expect.arrayContaining(["terminal-content", "nodrag", "nopan"]),
      )
      expect(root.hidden).toBe(false)
      expect(root.hasAttribute("inert")).toBe(false)
      expect(root.hasAttribute("data-locked")).toBe(false)
      // The mount's input is inside it, and the host adds none.
      expect(root.querySelectorAll("[data-terminal-input]")).toHaveLength(1)
    })

    it("keeps plain wheel scrolling to itself and lets zoom gestures through", () => {
      const { container } = show()
      const reached: boolean[] = []
      container.addEventListener("wheel", (event) => reached.push(event.ctrlKey))
      const root = content(container)
      root.dispatchEvent(new WheelEvent("wheel", { bubbles: true }))
      root.dispatchEvent(new WheelEvent("wheel", { bubbles: true, ctrlKey: true }))
      root.dispatchEvent(new WheelEvent("wheel", { bubbles: true, metaKey: true }))
      expect(reached).toEqual([true, false])
    })

    it("gives the element the screen's classes, and room for the ending bar while one shows", () => {
      const { created, change } = show()
      const { element } = created[0]!
      expect([...element.classList]).toEqual(
        expect.arrayContaining(["terminal-screen", "flex", "min-h-0", "flex-1", "flex-col"]),
      )
      expect(element.classList.contains("mb-7")).toBe(false)
      change({
        terminal: { ...terminalFixture(1, "~"), state: "exited", exitCode: 1, signal: null },
      })
      expect(element.classList.contains("mb-7")).toBe(true)
      change({ terminal: running() })
      expect(element.classList.contains("mb-7")).toBe(false)
    })

    it("sends the mount the props that changed, and whether it is on screen", () => {
      const { mounts, change } = show()
      change({ terminal: { ...running(), name: "Build" } })
      change({ onScreen: false })
      expect(mounts[0]!.update).toHaveBeenLastCalledWith({
        name: "Build",
        status: "running",
        view: "focus",
        onScreen: false,
      })
    })

    it("disposes the mount of a terminal it no longer shows and mounts the new one", () => {
      const next: TerminalKey = { ...key, terminalId: "02" }
      const { created, mounts, change } = show()
      change({ terminalKey: next })
      expect(mounts[0]!.dispose).toHaveBeenCalledTimes(1)
      expect(created.map((mounted) => mounted.key)).toEqual([key, next])
      expect(mounts).toHaveLength(2)
      expect(mounts[1]!.dispose).not.toHaveBeenCalled()
    })

    it("disposes the mount while its element is still in the page, once", () => {
      const { mounts, log, unmount } = show()
      unmount()
      expect(mounts[0]!.dispose).toHaveBeenCalledTimes(1)
      expect(log.disposedInPage).toEqual([true])
    })
  })

  context("when the UI wraps its content in a window", () => {
    it("renders its one content element inside the window", () => {
      const { container } = show({ renderWindow: inFirst })
      const window = container.querySelector("[data-window=first]")!
      expect(window.querySelectorAll("[data-terminal-content]")).toHaveLength(1)
      expect(container.querySelectorAll("[data-terminal-content]")).toHaveLength(1)
    })

    it("keeps the terminal when the window changes and back, mounting once", () => {
      const { container, created, change, mounts } = show({ renderWindow: inFirst })
      const { element } = created[0]!
      const field = element.querySelector("[data-terminal-input]")
      for (const renderWindow of [inSecond, inFirst]) {
        change({ renderWindow })
        expect(container.querySelectorAll("[data-terminal-content]")).toHaveLength(1)
        expect(container.querySelector("[data-window]")?.contains(element)).toBe(true)
        expect(element.querySelector("[data-terminal-input]")).toBe(field)
      }
      expect(created).toHaveLength(1)
      expect(mounts[0]!.dispose).not.toHaveBeenCalled()
    })

    it("keeps the focus it held while the body around it changes", () => {
      const { container, created, change } = show({ renderWindow: inFirst })
      const field = created[0]!.element.querySelector<HTMLElement>("[data-terminal-input]")!
      act(() => field.focus())
      expect(document.activeElement).toBe(field)
      change({ renderWindow: inSecond })
      expect(container.querySelector("[data-window=second]")?.contains(field)).toBe(true)
      expect(document.activeElement).toBe(field)
      // Focus that was elsewhere stays there.
      const outside = document.createElement("button")
      document.body.append(outside)
      act(() => outside.focus())
      change({ renderWindow: inFirst })
      expect(document.activeElement).toBe(outside)
      outside.remove()
    })
  })

  context("when keyboard navigation asks for its input", () => {
    it("focuses it and reports once the focus landed", () => {
      const onFocused = vi.fn<() => void>()
      const { created, mounts, change } = show({ onInputFocused: onFocused })
      expect(onFocused).not.toHaveBeenCalled()
      change({ focusInput: true, onInputFocused: onFocused })
      expect(mounts[0]!.focus).toHaveBeenCalled()
      expect(document.activeElement).toBe(created[0]!.element.querySelector("textarea"))
      expect(onFocused).toHaveBeenCalledTimes(1)
    })

    it("keeps the request standing while the focus does not land", () => {
      const onFocused = vi.fn<() => void>()
      const fake = stub()
      fake.landing.value = false
      const page = render(
        hosted(fake.mountTerminal, { focusInput: true, onInputFocused: onFocused }),
      )
      expect(fake.mounts[0]!.focus).toHaveBeenCalled()
      expect(onFocused).not.toHaveBeenCalled()
      // The next time something it depends on changes, it asks again, and lands.
      fake.landing.value = true
      const next = vi.fn<() => void>()
      page.rerender(hosted(fake.mountTerminal, { focusInput: true, onInputFocused: next }))
      expect(next).toHaveBeenCalledTimes(1)
      page.unmount()
    })

    it("asks after the props reach the mount, so a terminal back on screen takes the focus", () => {
      const onFocused = vi.fn<() => void>()
      const { change, mounts } = show({ onScreen: false, onInputFocused: onFocused })
      change({ onScreen: true, focusInput: true })
      expect(mounts[0]!.update.mock.invocationCallOrder[0]!).toBeLessThan(
        mounts[0]!.focus.mock.invocationCallOrder[0]!,
      )
      expect(onFocused).toHaveBeenCalledTimes(1)
    })

    it("does not ask while it is not wanted", () => {
      const { mounts } = show({ focusInput: false })
      expect(mounts[0]!.focus).not.toHaveBeenCalled()
    })
  })

  context("while its input is refused", () => {
    it.each([
      ["starting", "Starting shell…"],
      ["loading", "Loading output…"],
      ["reconnecting", "Reconnecting…"],
      ["offline", "Runner offline"],
    ] as const)("says why, as %s, over the dimmed screen", (lock, words) => {
      const { container, state } = show()
      act(() => void state.update((current) => ({ ...current, lock })))
      expect(container.querySelector("[role=status]")?.textContent).toBe(words)
      expect(content(container).hasAttribute("data-locked")).toBe(true)
      act(() => void state.update((current) => ({ ...current, lock: null })))
      expect(container.querySelector("[role=status]")).toBeNull()
      expect(content(container).hasAttribute("data-locked")).toBe(false)
    })
  })

  context("when a paste failed", () => {
    it("says why at the top, announces it, and lets the notice go", () => {
      const { container, state } = show()
      act(
        () => void state.update((current) => ({ ...current, notice: "Couldn't paste the image" })),
      )
      expect(container.querySelector("[data-paste-notice]")?.textContent).toBe(
        "Couldn't paste the image",
      )
      expect(container.querySelector("[aria-live]:last-of-type")?.textContent).toBe(
        "Couldn't paste the image",
      )
      act(() => void state.update((current) => ({ ...current, notice: null })))
      expect(container.querySelector("[data-paste-notice]")).toBeNull()
      expect(container.querySelector("[aria-live]:last-of-type")?.textContent).toBe("")
    })
  })

  context("while its shell runs", () => {
    it("shows no ending", () => {
      const { container } = show()
      expect(container.querySelector("[data-terminal-ending]")).toBeNull()
    })
  })

  context("once its shell ended", () => {
    // How it ended, in full in its tooltip when the bar is too narrow.
    const ending = '[data-scope="tooltip"][data-part="trigger"]'
    const exited = (exitCode: number | null, signal: string | null): TerminalMetadata => ({
      ...terminalFixture(1, "~"),
      state: "exited",
      exitCode,
      signal,
    })

    it("says how under its output, in honey for an exit code, and announces it", () => {
      const { container } = show({ terminal: exited(3, null) })
      const bar = container.querySelector<HTMLElement>("[data-terminal-ending]")
      expect(bar?.dataset.terminalEnding).toBe("warning")
      // The announcer sits outside the bar, which is inert while hidden.
      const announcer = container.querySelector("[aria-live=polite]")
      expect(announcer?.textContent).toBe("Exited · code 3")
      expect(announcer?.closest("[inert]")).toBeNull()
      expect(bar?.querySelector(ending)?.textContent).toBe("Exited · code 3")
    })

    it("names why it could not start, in rose", () => {
      const { container } = show({
        terminal: { ...terminalFixture(1, "~"), state: "failed", message: "Folder not found" },
      })
      const bar = container.querySelector<HTMLElement>("[data-terminal-ending]")
      expect(bar?.dataset.terminalEnding).toBe("danger")
      expect(bar?.querySelector(ending)?.textContent).toBe("Failed to start · Folder not found")
    })

    it("announces it from a region that outlives the program's body changing", () => {
      const { container, change } = show({ renderWindow: inFirst })
      const announcer = container.querySelector("[aria-live=polite]")
      const root = content(container)
      expect(announcer?.textContent).toBe("")

      // The agent's shell is killed: the plain body replaces the agent's.
      change({ terminal: exited(null, "SIGKILL"), renderWindow: inSecond })
      expect(content(container)).not.toBe(root)
      expect(container.querySelector("[aria-live=polite]")).toBe(announcer)
      expect(announcer?.textContent).toBe("Killed · SIGKILL")
    })

    it("starts a fresh shell from its Restart button, then focuses it", () => {
      const { container, mounts } = show({ terminal: exited(null, "SIGKILL") })
      act(() => container.querySelector<HTMLElement>("[data-terminal-ending] button")!.click())
      expect(mounts[0]!.restart).toHaveBeenCalledTimes(1)
      expect(mounts[0]!.focus).toHaveBeenCalledTimes(1)
      expect(
        mounts[0]!.restart.mock.invocationCallOrder[0]! <
          mounts[0]!.focus.mock.invocationCallOrder[0]!,
      ).toBe(true)
    })

    it("holds Restart back while the terminal is locked, until it takes input again", () => {
      const { container, mounts, state } = show({ terminal: exited(1, null) })
      act(() => void state.update((current) => ({ ...current, lock: "offline" })))
      const button = container.querySelector<HTMLElement>("[data-terminal-ending] button")!
      expect(button.getAttribute("aria-disabled")).toBe("true")
      act(() => button.click())
      expect(mounts[0]!.restart).not.toHaveBeenCalled()
      act(() => void state.update((current) => ({ ...current, lock: null })))
      expect(button.hasAttribute("aria-disabled")).toBe(false)
      act(() => button.click())
      expect(mounts[0]!.restart).toHaveBeenCalledTimes(1)
    })
  })
})
