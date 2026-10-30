import { terminalFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"

import { describe, expect, it } from "../../test"
import { WindowShell } from "../WindowShell"
import { ClaudeBody } from "./ClaudeBody"
import { CodexBody } from "./CodexBody"

const noop = (): void => {}

describe("process bodies", () => {
  it.each([ClaudeBody, CodexBody])(
    "shows a program's body and icon in the shared window, keeping the switcher action",
    (Body) => {
      const opened: HTMLButtonElement[] = []
      const page = render(
        createElement(
          WindowShell,
          {
            terminal: terminalFixture(1, "~/project"),
            icon: createElement("svg", { "data-custom-icon": "" }),
            rename: null,
            onBeginRename: noop,
            onRenameDraft: noop,
            onRenameSave: noop,
            onRenameCancel: noop,
            switcher: { onOpen: (button) => void opened.push(button) },
          },
          createElement(Body, null, createElement("article", null, "Custom process content")),
        ),
      )
      try {
        expect(page.container.querySelector("article")?.textContent).toBe("Custom process content")
        const button = page.container.querySelector<HTMLButtonElement>(
          'button[aria-label="Switch terminal"]',
        )!
        expect(button.querySelector("[data-custom-icon]")).not.toBeNull()
        act(() => button.click())
        expect(opened).toEqual([button])
      } finally {
        page.unmount()
      }
    },
  )
})
