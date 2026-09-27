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

const statusOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-terminal-status]")

describe("terminal frame status", () => {
  context("when the process exited", () => {
    it("shows the exit code after the terminal name", () => {
      const frame = renderFrame({ ...terminalFixture(1, "~/p"), state: "exited", exitCode: 1 })
      const status = statusOf(frame)
      expect(status?.textContent).toBe("Exited · code 1")
      expect(status?.previousElementSibling?.textContent).toBe("Terminal 01")
      expect(frame.querySelector("section")?.getAttribute("aria-label")).toBe(
        "Terminal 01 terminal",
      )
    })
  })

  context("when the process failed to start", () => {
    it("keeps the failure message in the label's tooltip text", () => {
      const frame = renderFrame({
        ...terminalFixture(1, "~/p"),
        state: "failed",
        message: "zsh not found",
      })
      expect(statusOf(frame)?.textContent).toBe("Failed to start")
      expect(statusOf(frame)?.title).toBe("zsh not found")
    })
  })

  context("when the process is running", () => {
    it("renders no status label", () => {
      expect(statusOf(renderFrame(terminalFixture(1, "~/p")))).toBeNull()
    })
  })
})
