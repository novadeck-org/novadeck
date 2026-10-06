import { act, createElement, type ReactNode } from "react"
import { afterEach, vi } from "vitest"

import { createStore } from "../../model/store"
import type { TerminalMetadata } from "../../model/types"
import { context, describe, expect, it } from "../../test"
import { render, type Rendered } from "../../test/render"
import type { BackendConnectionState, TerminalKey } from "../port"
import { terminalKeyId } from "../registry"
import type { DemoScreen } from "./debug/types"
import { createDemoTerminal } from "./DemoTerminal"
import { createDemoEngine } from "./engine"

const key: TerminalKey = { projectId: "p", workspaceSessionId: "s", terminalId: "01" }
const shell: TerminalMetadata = {
  id: "01",
  name: "Terminal 01",
  directory: "~",
  command: "zsh",
  process: "zsh",
  state: "idle",
}
const ended: TerminalMetadata = { ...shell, state: "exited", exitCode: 3, signal: null }

const mounted: Rendered[] = []
afterEach(() => mounted.splice(0).forEach((view) => view.unmount()))

const mount = (terminal: TerminalMetadata, withRuntime: boolean) => {
  const connection = createStore<BackendConnectionState>("connected")
  const screens = createStore<ReadonlyMap<string, DemoScreen>>(new Map())
  const restart = vi.fn<(key: TerminalKey) => void>()
  const Surface = createDemoTerminal(
    createDemoEngine(),
    undefined,
    withRuntime ? { connection, screens, restart } : undefined,
  )
  const view = render(
    createElement(Surface, {
      terminalKey: key,
      terminal,
      projectName: "novadeck",
      fontSize: 13,
      focusInput: false,
      onInputFocused: () => {},
      renderWindow: (content: ReactNode) => content,
    }),
  )
  mounted.push(view)
  const input = view.container.querySelector<HTMLInputElement>("[data-terminal-input]")!
  const form = view.container.querySelector("form")!
  const press = (): void => act(() => form.requestSubmit())
  const showScreen = (screen: DemoScreen): void =>
    act(() => void screens.update(() => new Map([[terminalKeyId(key), screen]])))
  return { view, connection, showScreen, restart, input, press }
}

describe("demo terminal surface", () => {
  context("without a runtime", () => {
    it("is its own root and shows no ending", () => {
      const { view } = mount(ended, false)
      const root = view.container.firstElementChild!
      expect(root.hasAttribute("data-terminal-content")).toBe(true)
      expect(view.container.querySelector("[data-terminal-ending]")).toBeNull()
    })
  })

  context("with a runtime", () => {
    it("keeps one content root, which frames the output", () => {
      const { view } = mount(shell, true)
      expect(view.container.querySelectorAll("[data-terminal-content]")).toHaveLength(1)
      const root = view.container.querySelector("[data-terminal-content]")!
      expect(root.classList.contains("terminal-content")).toBe(true)
      expect(root.classList.contains("nodrag")).toBe(true)
      expect(root.querySelector("[data-terminal-input]")).not.toBeNull()
    })

    it("shows how an ended shell ended, with Restart", () => {
      const { view, restart } = mount(ended, true)
      expect(view.container.querySelector("[data-terminal-ending]")?.textContent).toContain(
        "Exited · code 3",
      )
      act(() => view.container.querySelector<HTMLButtonElement>(".terminal-restart")?.click())
      expect(restart).toHaveBeenCalledWith(key)
    })

    it("restarts on Enter once the shell ended", () => {
      const { restart, press } = mount(ended, true)
      press()
      expect(restart).toHaveBeenCalledWith(key)
    })

    it("shows no ending for a shell that runs", () => {
      const { view } = mount(shell, true)
      expect(view.container.querySelector("[data-terminal-ending]")).toBeNull()
    })

    it("locks while the connection is away, and refuses Restart and Enter", () => {
      const { view, connection, restart, input, press } = mount(ended, true)
      act(() => void connection.update(() => "reconnecting"))
      expect(view.container.querySelector(".terminal-lock")?.textContent).toBe("Reconnecting…")
      expect(input.getAttribute("aria-disabled")).toBe("true")
      press()
      act(() => view.container.querySelector<HTMLButtonElement>(".terminal-restart")?.click())
      expect(restart).not.toHaveBeenCalled()
      act(() => void connection.update(() => "unavailable"))
      expect(view.container.querySelector(".terminal-lock")?.textContent).toBe("Runner offline")
      act(() => void connection.update(() => "connected"))
      expect(view.container.querySelector(".terminal-lock")).toBeNull()
    })

    it("locks while its shell starts", () => {
      const { view } = mount({ ...shell, state: "starting" }, true)
      expect(view.container.querySelector(".terminal-lock")?.textContent).toBe("Starting shell…")
    })

    it("locks while its output is on the way", () => {
      const { view, showScreen } = mount(shell, true)
      showScreen({ attaching: true })
      expect(view.container.querySelector(".terminal-lock")?.textContent).toBe("Loading output…")
      showScreen({})
      expect(view.container.querySelector(".terminal-lock")).toBeNull()
    })

    it("shows a notice at the top without locking", () => {
      const { view, showScreen } = mount(shell, true)
      showScreen({ notice: "Novadeck can't read the clipboard" })
      expect(view.container.querySelector("[data-paste-notice]")?.textContent).toBe(
        "Novadeck can't read the clipboard",
      )
      expect(view.container.querySelector(".terminal-lock")).toBeNull()
    })
  })
})
