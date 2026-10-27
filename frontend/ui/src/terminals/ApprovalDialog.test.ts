import type { Approval } from "@novadeck/core/port"
import type { Workspace } from "@novadeck/core/types"
import { render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { ApprovalDialog, approvalView, sameApprovalView, type ApprovalView } from "./ApprovalDialog"

const mounted: Rendered[] = []
afterEach(() => mounted.splice(0).forEach((page) => page.unmount()))

const dialog = () => document.querySelector<HTMLElement>("[role=alertdialog]")
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))

const view = (fields: Partial<ApprovalView> = {}): ApprovalView => ({
  requestId: "ask-1",
  action: { type: "close" },
  asker: { name: "api-server", process: "claude", handle: "moth" },
  target: { name: "web", process: "codex", handle: "fox" },
  ...fields,
})

const show = (ask: ApprovalView | null) => {
  const onAnswer = vi.fn<(requestId: string, approved: boolean) => void>()
  const page = render(createElement(ApprovalDialog, { ask, onAnswer }))
  mounted.push(page)
  const button = (name: string) =>
    [...(dialog()?.querySelectorAll("button") ?? [])].find((item) => item.textContent === name)!
  const showNext = (next: ApprovalView | null) =>
    page.rerender(createElement(ApprovalDialog, { ask: next, onAnswer }))
  return { button, onAnswer, showNext }
}

describe("approval dialog", () => {
  context("when an agent asks to close a terminal", () => {
    it("names both terminals and the agents that run in them", async () => {
      show(view())
      await settle()
      expect(dialog()?.textContent).toContain("Close @fox · “web”?")
      expect(dialog()?.textContent).toContain(
        "@moth · “api-server” (Claude Code) asks to close it. Codex is running there.",
      )
    })

    it("names each harness as people call it", async () => {
      const { showNext } = show(
        view({ asker: { name: "a", process: "codex" }, target: { name: "b", process: "agy" } }),
      )
      await settle()
      expect(dialog()?.textContent).toContain("“a” (Codex) asks to close it. Antigravity is")
      showNext(
        view({
          requestId: "ask-2",
          asker: { name: "a", process: "agy" },
          target: { name: "b", process: "claude" },
        }),
      )
      await settle()
      expect(dialog()?.textContent).toContain("“a” (Antigravity) asks to close it. Claude Code is")
    })

    it("still reads sensibly when the app doesn't know the terminals yet", async () => {
      show(view({ asker: undefined, target: undefined }))
      await settle()
      expect(dialog()?.textContent).toContain("Close a terminal?")
      expect(dialog()?.textContent).toContain("An agent asks to close a terminal.")
    })
  })

  context("when an agent asks to lead a terminal", () => {
    const lead = (brief = "Review the diff.\nDon't push.") =>
      view({ action: { type: "lead", brief } })

    it("names both agents by handle and shows the brief as plain text", async () => {
      show(lead("<b>Review</b> the diff.\nDon't push."))
      await settle()
      expect(dialog()?.textContent).toContain("Let @moth lead @fox?")
      expect(dialog()?.textContent).toContain(
        "@moth · “api-server” (Claude Code) asks to direct @fox · “web” (Codex) from now on, and could then close it too.",
      )
      const brief = dialog()?.querySelector("pre")
      expect(brief?.textContent).toBe("<b>Review</b> the diff.\nDon't push.")
      expect(brief?.querySelector("b")).toBeNull()
    })

    it("still reads sensibly when the app doesn't know the terminals yet", async () => {
      show({ ...lead(), asker: undefined, target: undefined })
      await settle()
      expect(dialog()?.textContent).toContain("Let an agent lead a terminal?")
    })

    it("lets it lead on Let it lead, and declines on Decline", async () => {
      const { button, onAnswer, showNext } = show(lead())
      await settle()
      act(() => button("Let it lead").click())
      expect(onAnswer).toHaveBeenLastCalledWith("ask-1", true)
      showNext({ ...lead(), requestId: "ask-2" })
      await settle()
      act(() => button("Decline").click())
      expect(onAnswer).toHaveBeenLastCalledWith("ask-2", false)
    })
  })

  context("when the person answers", () => {
    it("closes the terminal on Close terminal", async () => {
      const { button, onAnswer } = show(view())
      await settle()
      act(() => button("Close terminal").click())
      expect(onAnswer).toHaveBeenCalledExactlyOnceWith("ask-1", true)
    })

    it("keeps it open on Keep open", async () => {
      const { button, onAnswer } = show(view())
      await settle()
      act(() => button("Keep open").click())
      expect(onAnswer).toHaveBeenCalledExactlyOnceWith("ask-1", false)
    })
  })

  context("when the ask goes away", () => {
    it("closes without an answer", async () => {
      const { showNext, onAnswer } = show(view())
      await settle()
      showNext(null)
      await settle()
      expect(dialog()).toBeNull()
      expect(onAnswer).not.toHaveBeenCalled()
    })
  })

  context("when another ask waits behind it", () => {
    it("asks the next one once the first is answered", async () => {
      const { button, onAnswer, showNext } = show(view())
      await settle()
      act(() => button("Close terminal").click())
      showNext(view({ requestId: "ask-2", target: { name: "docs", process: "", handle: "owl" } }))
      await settle()
      expect(dialog()?.textContent).toContain("Close @owl · “docs”?")
      act(() => button("Keep open").click())
      expect(onAnswer).toHaveBeenLastCalledWith("ask-2", false)
    })
  })
})

describe("approval view", () => {
  const terminal = (id: string, name: string) => ({ id, name, process: "claude", handle: name })
  const workspace = {
    projects: [
      {
        history: [
          { state: { roster: { terminals: [terminal("t1", "moth")] } } },
          { state: { roster: { terminals: [terminal("t2", "fox")] } } },
        ],
      },
    ],
  } as unknown as Workspace
  const ask: Approval = { requestId: "r", from: "t1", terminalId: "t2", action: { type: "close" } }

  it("finds the terminals in any session", () => {
    const found = approvalView(ask, workspace)
    expect(found.asker?.name).toBe("moth")
    expect(found.target?.name).toBe("fox")
  })

  it("leaves out a terminal it doesn't know", () => {
    const found = approvalView({ ...ask, from: "nope" }, workspace)
    expect(found.asker).toBeUndefined()
    expect(sameApprovalView(found, approvalView({ ...ask, from: "nope" }, workspace))).toBe(true)
  })
})
