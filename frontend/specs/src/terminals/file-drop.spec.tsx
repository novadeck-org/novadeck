import { scriptedRunner } from "@novadeck/runner-adapter/scripted-server"
import { App } from "@novadeck/ui/app/App"
import { pageTheme } from "@novadeck/ui/theme/source"
import { onTestFinished } from "vitest"
import { cleanup, render } from "vitest-browser-react"
import { page } from "vitest/browser"

import { companionPane, openShowcase } from "../support/companions"
import { expectStaysTrue } from "../support/layouts"
import {
  chooseView,
  expectSelected,
  layoutSettled,
  sidebar,
  terminal,
  terminalTab,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

// Files dragged from a file manager onto a runner's terminal, as the browser hands them to the
// page. A browser's own file has no path the page knows, so each one is saved on the runner and
// its path there typed, as for a paste of it: the desktop app's own paths are the unit tests'.

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

// What the app typed into one terminal, as one string.
const heard = (runner: ReturnType<typeof scriptedRunner>, at: number): string =>
  runner
    .typed()
    .filter(({ terminalId }) => terminalId === runner.terminalIds[at])
    .map(({ data }) => data)
    .join("")

// A drag event the browser sends at the middle of `target`, carrying `files` (or text alone), to
// what is drawn there and takes the pointer, as a real drag's goes. A page's own DataTransfer
// keeps no drop effect, which a real drag's does: the unit tests check it.
const drag = (
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  target: Element,
  carried: readonly File[] | string,
  data = new DataTransfer(),
): DragEvent => {
  if (typeof carried === "string") data.setData("text/plain", carried)
  else if (data.items.length === 0) for (const file of carried) data.items.add(file)
  // The middle of what is in sight of it: a Canvas window may reach past the page's edge.
  const box = target.getBoundingClientRect()
  const left = Math.max(box.left, 0)
  const top = Math.max(box.top, 0)
  const right = Math.min(box.right, window.innerWidth)
  const bottom = Math.min(box.bottom, window.innerHeight)
  const at = { x: (left + right) / 2, y: (top + bottom) / 2 }
  const event = new DragEvent(type, {
    dataTransfer: data,
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: at.x,
    clientY: at.y,
  })
  ;(document.elementFromPoint(at.x, at.y) ?? target).dispatchEvent(event)
  return event
}

// The files dragged over `target` and dropped there, as one drag.
const dropOn = (target: Element, files: readonly File[]): DragEvent => {
  const data = new DataTransfer()
  for (const file of files) data.items.add(file)
  drag("dragenter", target, files, data)
  drag("dragover", target, files, data)
  return drag("drop", target, files, data)
}

const screenOf = (name: string): Element => terminal(name).element().querySelector(".xterm-screen")!
// Waits for the terminal's screen, which a view mounts in its own time.
const screenShown = (name: string) =>
  expect.poll(() => terminal(name).element().querySelector(".xterm-screen")).not.toBeNull()
const highlight = (name: string) => terminal(name).element().querySelector("[data-file-drop]")
const notes = new File(["notes"], "notes.txt", { type: "text/plain" })

describe("Files dropped on a runner terminal", () => {
  for (const view of ["Focus", "Grid", "Canvas"] as const)
    context(`in ${view}`, () => {
      // Focus shows one terminal: the one dropped on there is the one shown.
      const target = view === "Focus" ? "Agent 1" : "Agent 2"
      const other = view === "Focus" ? null : "Agent 1"

      it("says it takes them while they're over it, and no other terminal does", async () => {
        await openRunner()
        await chooseView(view)
        await terminalTab("Agent 1").click()
        await screenShown(target)

        const over = drag("dragover", screenOf(target), [notes])

        expect(over.defaultPrevented).toBe(true)
        await expect.poll(() => highlight(target)?.textContent).toBe("Drop to paste its path")
        if (other) expect(highlight(other)).toBeNull()
        // Off the window, as the pointer leaves the page.
        drag("dragleave", screenOf(target), [notes])
        await expect.poll(() => highlight(target)).toBeNull()
      })

      it("counts the files over it", async () => {
        await openRunner()
        await chooseView(view)
        await screenShown(target)
        const two = [notes, new File(["b"], "b.txt", { type: "text/plain" })]

        drag("dragover", screenOf(target), two)

        await expect.poll(() => highlight(target)?.textContent).toBe("Drop to paste 2 paths")
        drag("drop", screenOf(target), two)
        await expect.poll(() => highlight(target)).toBeNull()
      })

      it("types each file's path on the runner, in order, and takes the keyboard", async () => {
        const runner = await openRunner()
        await chooseView(view)
        await terminalTab("Agent 1").click()
        await screenShown(target)
        const at = target === "Agent 1" ? 0 : 1

        const dropped = dropOn(screenOf(target), [
          notes,
          new File(["b"], "b.txt", { type: "text/plain" }),
        ])

        expect(dropped.defaultPrevented).toBe(true)
        await expect.poll(() => heard(runner, at)).toBe("/uploads/1/notes.txt /uploads/2/b.txt ")
        await expect.element(input(target)).toHaveFocus()
        await expectSelected(target)
        await expect.poll(() => highlight(target)).toBeNull()
      })
    })

  context("with a companion pane in the terminal's window", () => {
    it("takes nothing dropped on the pane beside the terminal, which takes its own", async () => {
      // Focus's window is wide enough for the pane to sit beside the terminal.
      await openShowcase("focus")
      await terminalTab("Build Studio").click()
      const pane = companionPane("Build Studio")
      await expect.element(pane.getByRole("tab", { name: "projects.json" })).toBeVisible()
      await screenShown("Build Studio")

      const over = drag("dragover", pane.element(), [notes])
      expect(over.defaultPrevented).toBe(true)
      await expectStaysTrue(() => highlight("Build Studio") === null, "no highlight over the pane")
      drag("dragover", screenOf("Build Studio"), [notes])
      await expect.poll(() => highlight("Build Studio")?.textContent).toBe("Drop to paste its path")
      // The tab's click left the keyboard in the terminal, which a drop on the pane doesn't give it.
      ;(document.activeElement as HTMLElement | null)?.blur()
      drag("drop", pane.element(), [notes])
      await expect.poll(() => highlight("Build Studio")).toBeNull()
      await expectStaysTrue(
        () => document.activeElement !== input("Build Studio").element(),
        "the keyboard stays out of the terminal",
      )
    })

    it("takes nothing dropped on a pane that covers the terminal, as in a narrow window", async () => {
      await openShowcase("grid")
      await expect
        .element(companionPane("Build Studio").getByRole("tab", { name: "projects.json" }))
        .toBeVisible()
      await screenShown("Build Studio")

      drag("dragover", screenOf("Build Studio"), [notes])

      await expectStaysTrue(() => highlight("Build Studio") === null, "no highlight under the pane")
    })
  })

  it("takes nothing dropped off the terminals, and never leaves the page", async () => {
    const runner = await openRunner()
    const place = sidebar().element()

    const over = drag("dragover", place, [notes])
    const dropped = drag("drop", place, [notes])

    expect(over.defaultPrevented).toBe(true)
    expect(dropped.defaultPrevented).toBe(true)
    await expectStaysTrue(() => runner.uploads().length === 0, "nothing uploaded")
    expect(runner.typed().map(({ data }) => data)).not.toContain("/uploads/1/notes.txt ")
  })

  it("leaves a drag of text alone", async () => {
    await openRunner()
    await screenShown("Agent 1")

    const over = drag("dragover", screenOf("Agent 1"), "some words")

    expect(over.defaultPrevented).toBe(false)
    expect(highlight("Agent 1")).toBeNull()
  })
})
