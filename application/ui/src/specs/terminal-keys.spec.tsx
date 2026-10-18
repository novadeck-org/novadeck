import { describe, expect, it, onTestFinished } from "vitest"
import { cleanup, render } from "vitest-browser-react"
import { page } from "vitest/browser"

import { App } from "../app/App"
import { scriptedRunner } from "../backend/runner/scripted-server"
import { pressShortcut, recentSwitcher } from "./support/keyboard"
import { layoutSettled, press, terminalTab } from "./support/workspace"
import { pageTheme } from "../theme/source"

// The app's shortcuts from a real terminal: the runner's, whose emulator reads the keys it
// takes (Ctrl+Tab as a Tab, Ctrl+Shift+Enter as Enter, Escape) and cancels them before they
// bubble, so the app hears them first, and the shell never does.

// Whether anything the app typed into the runner's terminals holds a Tab, Enter or Escape.
const shellGotKeys = (runner: ReturnType<typeof scriptedRunner>): boolean =>
  runner.typed().some(({ data }) => ["\t", "\r", "\x1b"].some((key) => data.includes(key)))

const input = (name: string) => page.getByRole("textbox", { name: `Input for ${name}` })

const openRunner = async () => {
  const runner = scriptedRunner({ terminals: 2 })
  const connection = await runner.connect(new AbortController().signal, pageTheme)
  onTestFinished(async () => {
    await cleanup()
    connection.close()
    await expect.poll(() => runner.connected()).toBe(false)
  })
  await render(<App createBackend={connection.createBackend} />)
  await layoutSettled()
  return runner
}

describe("the app's shortcuts typed into a runner terminal", () => {
  it("opens the terminal switcher with Ctrl+Tab, and closes it with Escape", async () => {
    const runner = await openRunner()
    await terminalTab("Agent 2").click()
    await terminalTab("Agent 1").click()
    await expect.element(input("Agent 1")).toHaveFocus()

    await press("{Control>}{Tab}")
    await expect.element(recentSwitcher()).toBeVisible()
    await press("{Escape}")
    await expect.element(recentSwitcher()).not.toBeInTheDocument()
    await press("{/Control}")
    await expect.element(input("Agent 1")).toHaveFocus()
    expect(shellGotKeys(runner)).toBe(false)
  })

  it("toggles Focus with its chord, keeping typing in the terminal", async () => {
    const runner = await openRunner()
    await terminalTab("Agent 1").click()
    await expect.element(input("Agent 1")).toHaveFocus()
    const focus = page.getByRole("radio", { name: "Focus" })
    const before = (focus.element() as HTMLInputElement).checked

    // ⌘Enter on a Mac, Ctrl+Shift+Enter elsewhere.
    await pressShortcut("focus")
    await expect.poll(() => (focus.element() as HTMLInputElement).checked).toBe(!before)
    await expect.element(input("Agent 1")).toHaveFocus()
    expect(shellGotKeys(runner)).toBe(false)
  })

  // The check above would pass on a runner that hears nothing: it hears what is typed.
  it("still hands the shell what the app leaves alone", async () => {
    const runner = await openRunner()
    await terminalTab("Agent 1").click()
    await expect.element(input("Agent 1")).toHaveFocus()
    await press("{Tab}")
    await expect.poll(() => shellGotKeys(runner)).toBe(true)
  })
})
