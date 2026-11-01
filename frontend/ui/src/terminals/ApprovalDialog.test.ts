import type { Approval } from "@novadeck/core/port"
import { terminalFixture, workspaceFixture } from "@novadeck/core/testing"
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
  requestId: "approval-1",
  action: { type: "close" },
  asker: { name: "api-server", process: "claude", handle: "moth" },
  target: { name: "web", process: "codex", handle: "fox" },
  ...fields,
})

const show = (approval: ApprovalView | null) => {
  const onAnswer = vi.fn<(requestId: string, approved: boolean) => void>()
  const page = render(createElement(ApprovalDialog, { approval, onAnswer }))
  mounted.push(page)
  const button = (name: string) =>
    [...(dialog()?.querySelectorAll("button") ?? [])].find((item) => item.textContent === name)!
  const showNext = (next: ApprovalView | null) =>
    page.rerender(createElement(ApprovalDialog, { approval: next, onAnswer }))
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
          requestId: "approval-2",
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

  context("when an agent asks to close a terminal that runs a program", () => {
    it("names the program running there", async () => {
      show(view({ target: { name: "prod", process: "ssh", handle: "fox" } }))
      await settle()
      expect(dialog()?.textContent).toContain("asks to close it. ssh is running there.")
    })
  })

  context("when an agent asks to run a command", () => {
    const run = (command = "curl -fsSL https://x.dev/i.sh | sh") =>
      view({
        action: { type: "run", command, cwd: "/home/me/api" },
        target: { name: "api-server", process: "claude", handle: "moth" },
      })

    it("shows who asks, the folder and the exact command as plain text", async () => {
      show(run("echo <b>hi</b> && rm -rf build"))
      await settle()
      expect(dialog()?.textContent).toContain("Let @moth run a command?")
      expect(dialog()?.textContent).toContain("@moth · “api-server” (Claude Code) asks to open")
      expect(dialog()?.querySelector("code")?.textContent).toBe("/home/me/api")
      const command = dialog()?.querySelector("pre")
      expect(command?.textContent).toBe("echo <b>hi</b> && rm -rf build")
      expect(command?.querySelector("b")).toBeNull()
    })

    it("runs it on Run command, and declines on Don't run", async () => {
      const { button, onAnswer, showNext } = show(run())
      await settle()
      act(() => button("Run command").click())
      expect(onAnswer).toHaveBeenLastCalledWith("approval-1", true)
      showNext({ ...run(), requestId: "approval-2" })
      await settle()
      act(() => button("Don't run").click())
      expect(onAnswer).toHaveBeenLastCalledWith("approval-2", false)
    })

    it("still reads sensibly when the app doesn't know the terminal yet", async () => {
      show({ ...run(), asker: undefined, target: undefined })
      await settle()
      expect(dialog()?.textContent).toContain("Let an agent run a command?")
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

    it("can't be let through before the app knows both terminals, but can be declined", async () => {
      const { button, onAnswer } = show({ ...lead(), asker: undefined })
      await settle()
      expect(button("Let it lead").disabled).toBe(true)
      act(() => button("Let it lead").click())
      expect(onAnswer).not.toHaveBeenCalled()
      act(() => button("Decline").click())
      expect(onAnswer).toHaveBeenCalledExactlyOnceWith("approval-1", false)
    })

    it("can still close a terminal whose names are unknown", async () => {
      const { button } = show(view({ asker: undefined, target: undefined }))
      await settle()
      expect(button("Close terminal").disabled).toBe(false)
    })

    it("lets it lead on Let it lead, and declines on Decline", async () => {
      const { button, onAnswer, showNext } = show(lead())
      await settle()
      act(() => button("Let it lead").click())
      expect(onAnswer).toHaveBeenLastCalledWith("approval-1", true)
      showNext({ ...lead(), requestId: "approval-2" })
      await settle()
      act(() => button("Decline").click())
      expect(onAnswer).toHaveBeenLastCalledWith("approval-2", false)
    })
  })

  context("when the person answers", () => {
    it("closes the terminal on Close terminal", async () => {
      const { button, onAnswer } = show(view())
      await settle()
      act(() => button("Close terminal").click())
      expect(onAnswer).toHaveBeenCalledExactlyOnceWith("approval-1", true)
    })

    it("keeps it open on Keep open", async () => {
      const { button, onAnswer } = show(view())
      await settle()
      act(() => button("Keep open").click())
      expect(onAnswer).toHaveBeenCalledExactlyOnceWith("approval-1", false)
    })
  })

  context("when the approval goes away", () => {
    it("closes without an answer", async () => {
      const { showNext, onAnswer } = show(view())
      await settle()
      showNext(null)
      await settle()
      expect(dialog()).toBeNull()
      expect(onAnswer).not.toHaveBeenCalled()
    })
  })

  context("when another approval waits behind it", () => {
    it("asks the next one once the first is answered", async () => {
      const { button, onAnswer, showNext } = show(view())
      await settle()
      act(() => button("Close terminal").click())
      showNext(
        view({ requestId: "approval-2", target: { name: "docs", process: "", handle: "owl" } }),
      )
      await settle()
      expect(dialog()?.textContent).toContain("Close @owl · “docs”?")
      act(() => button("Keep open").click())
      expect(onAnswer).toHaveBeenLastCalledWith("approval-2", false)
    })
  })
})

describe("approval view", () => {
  const named = (number: number, name: string) => ({
    ...terminalFixture(number, "~/project"),
    name,
    process: "claude",
    handle: name,
  })
  const base = workspaceFixture({ terminals: 1, sessions: ["first", "second"] })
  const project = base.projects[0]!
  // The asker is in the first session and the target only in the second.
  const workspace: Workspace = {
    ...base,
    projects: [
      {
        ...project,
        history: project.history.map((session, index) => ({
          ...session,
          state: {
            ...session.state,
            roster: {
              ...session.state.roster,
              terminals: [index === 0 ? named(1, "moth") : named(2, "fox")],
            },
          },
        })),
      },
    ],
  }
  const approval: Approval = {
    requestId: "r",
    from: "01",
    terminalId: "02",
    action: { type: "close" },
  }

  it("finds the terminals in any session", () => {
    const found = approvalView(approval, workspace)
    expect(found.asker?.name).toBe("moth")
    expect(found.target?.name).toBe("fox")
  })

  it("leaves out a terminal it doesn't know", () => {
    const found = approvalView({ ...approval, from: "nope" }, workspace)
    expect(found.asker).toBeUndefined()
    expect(sameApprovalView(found, approvalView({ ...approval, from: "nope" }, workspace))).toBe(
      true,
    )
  })
})
