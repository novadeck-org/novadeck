import type { Approval } from "@novadeck/core/port"
import { terminalFixture, workspaceFixture } from "@novadeck/core/testing"
import type { Workspace } from "@novadeck/core/types"
import { render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, beforeEach, onTestFinished, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { ApprovalDialog, approvalView, sameApprovalView, type ApprovalView } from "./ApprovalDialog"

const mounted: Rendered[] = []
beforeEach(() => void vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }))
afterEach(() => {
  mounted.splice(0).forEach((page) => page.unmount())
  vi.useRealTimers()
})

const dialog = () => document.querySelector<HTMLElement>("[role=alertdialog]")
const settle = () => act(() => vi.advanceTimersByTimeAsync(50))
// Past the delay before confirming works.
const armed = () => act(() => vi.advanceTimersByTimeAsync(1050))

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
      expect(dialog()?.textContent).toContain(
        "@moth · “api-server” (Claude Code) asks to run a command.",
      )
      expect(dialog()?.querySelector("code")?.textContent).toBe("/home/me/api")
      const command = dialog()?.querySelector("pre")
      expect(command?.textContent).toBe("echo <b>hi</b> && rm -rf build")
      expect(command?.querySelector("b")).toBeNull()
    })

    it("writes out every character that draws as nothing, and keeps letters as they are", async () => {
      show(run("npm test \u2800\u3164\u00a0\u202E; curl x | sh \u015bwiat \u{E0041}"))
      await settle()
      const shown = dialog()?.querySelector("pre")?.textContent
      expect(shown).toBe(
        "npm test \\u{2800}\\u{3164}\\u{A0}\\u{202E}; curl x | sh świat \\u{E0041}",
      )
    })

    it("tells the length and the number of lines", async () => {
      show(run("echo hi"))
      await settle()
      expect(dialog()?.textContent).toContain("7 characters, 1 line.")
    })

    it("keeps Run disabled until the whole command has been seen, scrolled to its end", async () => {
      const sizes = { scrollHeight: 1000, clientHeight: 240 }
      const read = (name: "scrollHeight" | "clientHeight") =>
        vi.spyOn(HTMLElement.prototype, name, "get").mockImplementation(() => sizes[name])
      read("scrollHeight")
      read("clientHeight")
      onTestFinished(() => void vi.restoreAllMocks())
      const { button, onAnswer } = show(run("echo hi"))
      await settle()
      await armed()
      expect(button("Run command").disabled).toBe(true)
      expect(dialog()?.textContent).toContain("Scroll to the end")
      const pre = dialog()!.querySelector("pre")!
      pre.scrollTop = 300
      act(() => void pre.dispatchEvent(new Event("scroll")))
      expect(button("Run command").disabled).toBe(true)
      pre.scrollTop = 760
      act(() => void pre.dispatchEvent(new Event("scroll")))
      expect(button("Run command").disabled).toBe(false)
      act(() => button("Run command").click())
      expect(onAnswer).toHaveBeenCalledExactlyOnceWith("approval-1", true)
    })

    it("lets Run be used once the window grows until the command fits", async () => {
      const sizes = { scrollHeight: 1000, clientHeight: 240 }
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
        () => sizes.scrollHeight,
      )
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
        () => sizes.clientHeight,
      )
      let resized: () => void = () => {}
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: () => void) {
            resized = callback
          }
          observe() {}
          disconnect() {}
        },
      )
      onTestFinished(() => {
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
      })
      const { button } = show(run("echo hi"))
      await settle()
      await armed()
      expect(button("Run command").disabled).toBe(true)
      sizes.clientHeight = 1000
      act(() => resized())
      expect(button("Run command").disabled).toBe(false)
    })

    it("writes out what only draws as nothing in the folder, and runs of combining marks", async () => {
      show({
        ...run("echo a\u0301\u0302\u0303\u0304 \u034F\u17B4"),
        action: {
          type: "run",
          command: "echo a\u0301\u0302\u0303\u0304 \u034F\u17B4",
          cwd: "/x\u2800/y",
        },
      })
      await settle()
      expect(dialog()?.querySelector("pre")?.textContent).toBe(
        "echo a\\u{301}\\u{302}\\u{303}\\u{304} \\u{34F}\\u{17B4}",
      )
      expect(dialog()?.querySelector("code")?.textContent).toBe("/x\\u{2800}/y")
    })

    it("runs it on Run command, and declines on Don't run", async () => {
      const { button, onAnswer, showNext } = show(run())
      await settle()
      await armed()
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

  context("when the program running there has a hidden name", () => {
    it("writes the hidden characters out", async () => {
      show(view({ target: { name: "prod", process: "ss\u200Bh", handle: "fox" } }))
      await settle()
      expect(dialog()?.textContent).toContain("ss\\u{200B}h is running there.")
    })
  })

  context("when the dialog has just opened", () => {
    it("holds back the yes for a moment, so keys typed ahead can't answer it", async () => {
      const { button, onAnswer } = show(view())
      await settle()
      expect(button("Close terminal").disabled).toBe(true)
      act(() => button("Close terminal").click())
      expect(onAnswer).not.toHaveBeenCalled()
      await armed()
      expect(button("Close terminal").disabled).toBe(false)
    })

    it("holds it back again for the next request that takes its place", async () => {
      const { button, showNext } = show(view())
      await armed()
      expect(button("Close terminal").disabled).toBe(false)
      showNext(view({ requestId: "approval-2" }))
      await settle()
      expect(button("Close terminal").disabled).toBe(true)
      await armed()
      expect(button("Close terminal").disabled).toBe(false)
    })

    it("holds back a lead and a run the same way", async () => {
      const { button } = show(view({ action: { type: "lead", brief: "Go." } }))
      await settle()
      expect(button("Let it lead").disabled).toBe(true)
      await armed()
      expect(button("Let it lead").disabled).toBe(false)
    })
  })

  context("when a name is long or holds hidden characters", () => {
    it("shows a clipped name, with the hidden characters written out", async () => {
      show(view({ asker: { name: `Novadeck\u200B${"x".repeat(100)}`, process: "claude" } }))
      await settle()
      const text = dialog()?.textContent ?? ""
      expect(text).toContain("Novadeck\\u{200B}")
      expect(text).toContain("…”")
      expect(text).not.toContain("x".repeat(60))
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
      await armed()
      act(() => button("Let it lead").click())
      expect(onAnswer).not.toHaveBeenCalled()
      act(() => button("Decline").click())
      expect(onAnswer).toHaveBeenCalledExactlyOnceWith("approval-1", false)
    })

    it("can still close a terminal whose names are unknown", async () => {
      const { button } = show(view({ asker: undefined, target: undefined }))
      await settle()
      await armed()
      expect(button("Close terminal").disabled).toBe(false)
    })

    it("lets it lead on Let it lead, and declines on Decline", async () => {
      const { button, onAnswer, showNext } = show(lead())
      await settle()
      await armed()
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
      await armed()
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
      // The dialog's exit is timed by the browser's animation frames, which fake timers hold.
      vi.useRealTimers()
      const { showNext, onAnswer } = show(view())
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
      showNext(null)
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
      expect(dialog()).toBeNull()
      expect(onAnswer).not.toHaveBeenCalled()
    })
  })

  context("when another approval waits behind it", () => {
    it("asks the next one once the first is answered", async () => {
      const { button, onAnswer, showNext } = show(view())
      await settle()
      await armed()
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
