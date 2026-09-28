import { Terminal } from "lucide-react"
import { act, createElement } from "react"

import type { TerminalMetadata } from "../../model/types"
import { context, describe, expect, it } from "../../test"
import { terminalFixture } from "../../test/fixtures"
import { render } from "../../test/render"
import { ClaudeIcon } from "../../ui-toolkit/icons/ClaudeIcon"
import { CodexIcon } from "../../ui-toolkit/icons/CodexIcon"
import { WindowShell } from "../WindowShell"
import { ClaudeBody } from "./ClaudeBody"
import { CodexBody } from "./CodexBody"
import { terminalProfile } from "./profiles"

const noop = (): void => {}

describe("process windows", () => {
  it.each([undefined, ClaudeBody, CodexBody])(
    "shows a program's body and icon in the shared window, keeping the switcher action",
    (Body) => {
      const opened: HTMLButtonElement[] = []
      const onOpen = (button: HTMLButtonElement): void => {
        opened.push(button)
      }
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
            switcher: { onOpen },
          },
          Body
            ? createElement(Body, null, createElement("article", null, "Custom process content"))
            : createElement("article", null, "Custom process content"),
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

const terminal = (process: string, status: Partial<TerminalMetadata> = {}) =>
  ({
    ...terminalFixture(1, "~/project"),
    process,
    state: "running",
    ...status,
  }) as TerminalMetadata

describe("terminal profile", () => {
  context("while a program holds the foreground", () => {
    it("presents Claude and Codex with their own bodies and icons", () => {
      expect(terminalProfile(terminal("claude"))).toEqual({
        icon: ClaudeIcon,
        Body: ClaudeBody,
      })
      expect(terminalProfile(terminal("codex"))).toEqual({
        icon: CodexIcon,
        Body: CodexBody,
      })
    })

    it("presents any other program as a plain terminal", () => {
      for (const process of ["vim", "node", "constructor"])
        expect(terminalProfile(terminal(process))).toEqual({ icon: Terminal })
    })
  })

  context("once the program no longer runs", () => {
    it("presents a plain terminal, whatever program was last seen", () => {
      const states: Partial<TerminalMetadata>[] = [
        { state: "idle" },
        { state: "starting" },
        { state: "failed", message: "Exited right after starting" },
        { state: "exited", exitCode: 1, signal: null },
      ]
      for (const status of states)
        expect(terminalProfile(terminal("claude", status))).toEqual({ icon: Terminal })
    })
  })
})
