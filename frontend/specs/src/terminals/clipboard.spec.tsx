import { scriptedRunner } from "@novadeck/runner-adapter/scripted-server"
import { App } from "@novadeck/ui/app/App"
import { pageTheme } from "@novadeck/ui/theme/source"
import { onTestFinished, vi } from "vitest"
import { cleanup, render } from "vitest-browser-react"
import { page } from "vitest/browser"

import { expectStaysTrue } from "../support/layouts"
import {
  isMac,
  layoutSettled,
  press,
  terminal,
  terminalLines,
  terminalTab,
} from "../support/workspace"
import { describe, expect, it } from "../test"

// The copy and paste keys in a runner's terminal, as its shell hears them: on Linux and
// Windows Ctrl+C copies a selection and interrupts without one, Ctrl+Shift+C only copies, and
// Ctrl+V or Ctrl+Shift+V paste; on a Mac the Ctrl keys stay the program's, as ⌘ copies and pastes.

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
  await terminalTab("Agent 1").click()
  await expect.element(input("Agent 1")).toHaveFocus()
  return runner
}

// Everything the app has typed into the runner's terminals, as one string.
const heard = (runner: ReturnType<typeof scriptedRunner>): string =>
  runner
    .typed()
    .map(({ data }) => data)
    .join("")

// Pastes `text` as the browser does once its paste key is pressed: a paste event on the input.
const pasteText = (text: string): void => {
  const data = new DataTransfer()
  data.setData("text/plain", text)
  input("Agent 1")
    .element()
    .dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    )
}

describe("the copy and paste keys in a runner terminal", () => {
  it("interrupts the program with Ctrl+C when nothing is selected", async () => {
    const runner = await openRunner()

    await press("{Control>}c{/Control}")

    await expect.poll(() => heard(runner)).toContain("\x03")
  })

  for (const [chord, keys] of [
    ["Ctrl+C", "{Control>}c{/Control}"],
    ["Ctrl+Shift+C", "{Control>}{Shift>}C{/Shift}{/Control}"],
  ])
    it.skipIf(isMac())(`copies a selection with ${chord}, and doesn't interrupt`, async () => {
      const runner = await openRunner()
      const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()
      runner.write(runner.terminalIds[0]!, "copyme\r\n")
      // Drawn on its top row before the double-click aims at it.
      await expect.poll(() => terminalLines("Agent 1")[0]).toContain("copyme")
      const screen = terminal("Agent 1").element().querySelector(".xterm-screen")!
      // A double-click on the word's first letters selects it.
      await page.elementLocator(screen).dblClick({ position: { x: 6, y: 6 } })

      await press(keys!)

      await expect.poll(() => copied.mock.calls).toEqual([["copyme"]])
      await expectStaysTrue(() => !heard(runner).includes("\x03"), "nothing interrupted")
    })

  it.skipIf(isMac())(
    "leaves Ctrl+V to the browser's paste, whose text the shell gets",
    async () => {
      const runner = await openRunner()
      // Whether each paste key was left to the browser, whose paste a prevented key never fires.
      const leftAlone: boolean[] = []
      const note = (event: KeyboardEvent): void => {
        if (event.key.toLowerCase() === "v") leftAlone.push(!event.defaultPrevented)
      }
      window.addEventListener("keydown", note)
      onTestFinished(() => window.removeEventListener("keydown", note))

      await press("{Control>}v{/Control}")
      await press("{Control>}{Shift>}V{/Shift}{/Control}")
      pasteText("echo pasted")

      await expect.poll(() => heard(runner)).toContain("echo pasted")
      expect(leftAlone).toEqual([true, true])
      // Neither key reached the program as its own ^V.
      expect(heard(runner)).not.toContain("\x16")
    },
  )

  it.runIf(isMac())("leaves Ctrl+V to the program on a Mac", async () => {
    const runner = await openRunner()

    await press("{Control>}v{/Control}")

    await expect.poll(() => heard(runner)).toContain("\x16")
  })
})
