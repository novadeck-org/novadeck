import { createElement } from "react"
import { afterEach } from "vitest"

import type { TerminalMetadata } from "../model/types"
import { context, describe, expect, it } from "../test"
import { terminalFixture } from "../test/fixtures"
import { render } from "../test/render"
import { TerminalFrame, type TerminalFrameProps } from "./TerminalFrame"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const ignore = (): void => {}

const renderFrame = (terminal: TerminalMetadata): HTMLElement => {
  const props: TerminalFrameProps = {
    terminal,
    children: null,
    rename: null,
    onBeginRename: ignore,
    onRenameDraft: ignore,
    onRenameSave: ignore,
    onRenameCancel: ignore,
  }
  const { container, unmount } = render(createElement(TerminalFrame, props))
  unmounts.push(unmount)
  return container
}

describe("terminal frame header", () => {
  context("when the shell ended", () => {
    it("leaves how it ended to the terminal's own bar and names only the terminal", () => {
      const frame = renderFrame({
        ...terminalFixture(1, "~/p"),
        state: "exited",
        exitCode: 1,
        signal: null,
      })
      expect(frame.querySelector(".terminal-title")?.textContent).toBe("Terminal 01")
      expect(frame.querySelector("section")?.getAttribute("aria-label")).toBe(
        "Terminal 01 terminal",
      )
    })
  })
})
