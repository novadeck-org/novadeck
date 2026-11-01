import {
  demoAutoRunManual,
  demoAutoRunOffer,
  demoAutoRunSilenced,
} from "@novadeck/demo/inbox/fixtures"
import { beforeEach } from "vitest"
import { page } from "vitest/browser"

import { desktopWindow, forgetDesktopWindow } from "../support/backend"
import { openWorkspace, sidebarPanel, skipWelcome } from "../support/workspace"
import { describe, expect, it } from "../test"

// cmd's AutoRun on Windows (approvals-design.md, Appendix F) on the demo backend: the Inbox's
// card for the offer, the manual step and the silenced state, and Preferences' row with Undo.
// The states are the debug panel's AutoRun actions; the spec's app (`&desktop=on`) lets it set
// them as the panel does.
const route =
  "/projects/storefront/sessions/initial/focus?terminal=storefront-initial-01&desktop=on"

beforeEach(forgetDesktopWindow)

const autorun = () => page.getByRole("region", { name: "cmd's AutoRun" })

const openInbox = async (): Promise<void> => {
  await openWorkspace(route)
  await skipWelcome()
  await sidebarPanel("Inbox").click()
}

describe("cmd's AutoRun card", () => {
  it("is not there where cmd prints nothing", async () => {
    await openInbox()

    await expect.element(autorun()).not.toBeInTheDocument()
  })

  it("shows why, the value now, the exact new one and that it applies to every cmd window, and Silence makes the change", async () => {
    await openInbox()
    desktopWindow.autorun(demoAutoRunOffer)

    await expect.element(autorun()).toMatchTextContent("Antigravity asks for each command")
    await expect.element(autorun()).toMatchTextContent("chcp 65001")
    await expect.element(autorun()).toMatchTextContent("(chcp 65001) >nul 2>&1")
    await expect.element(autorun()).toMatchTextContent("every cmd window")

    await autorun().getByRole("button", { name: "Silence cmd's AutoRun output" }).click()

    await expect.element(autorun()).toMatchTextContent("cmd's AutoRun is silenced")
    await expect.element(autorun()).toMatchTextContent("cmd prints nothing now")
    await expect.element(autorun().getByRole("button", { name: "Undo" })).toBeVisible()
  })

  it("says that redirecting the output also hides what the AutoRun shows in a cmd window", async () => {
    await openInbox()
    desktopWindow.autorun(demoAutoRunOffer)

    await expect.element(autorun()).toMatchTextContent("prompts, colours, messages")
  })

  it("writes out a character nothing shows, so a value can't hide one", async () => {
    await openInbox()
    desktopWindow.autorun({
      state: "offer",
      current: "chcp\u200B 65001",
      next: "(chcp\u200B 65001) >nul 2>&1",
      machine: null,
      outcome: null,
    })

    await expect.element(autorun()).toMatchTextContent("chcp\\u{200B} 65001")
  })

  it("goes away on Not now", async () => {
    await openInbox()
    desktopWindow.autorun(demoAutoRunOffer)
    await autorun().getByRole("button", { name: "Not now" }).click()

    await expect.element(autorun()).not.toBeInTheDocument()
  })

  it("gives the step in words, and never a command line, where the machine's AutoRun prints", async () => {
    await openInbox()
    desktopWindow.autorun(demoAutoRunManual)

    await expect
      .element(autorun())
      .toMatchTextContent("the machine's (HKLM), which needs an administrator")
    await expect.element(autorun()).toMatchTextContent("in regedit, as an administrator")
    await expect.element(autorun()).toMatchTextContent("(chcp 65001) >nul 2>&1")
    await expect
      .element(autorun().getByRole("button", { name: "Silence cmd's AutoRun output" }))
      .not.toBeInTheDocument()
    await expect.element(autorun()).not.toHaveTextContent("reg add")
  })

  it("gives the machine's step too once silenced, where the machine's AutoRun holds a value", async () => {
    await openInbox()
    desktopWindow.autorun({
      state: "silenced",
      current: "(chcp 65001) >nul 2>&1",
      restores: "chcp 65001",
      machine: "chcp 437",
      suggested: "(chcp 437) >nul 2>&1",
      outcome: { kind: "applied-still-prints-hklm" },
    })

    await expect
      .element(autorun())
      .toMatchTextContent("cmd still prints: the machine's AutoRun does")
    await expect.element(autorun()).toMatchTextContent("in regedit, as an administrator")
    await expect.element(autorun()).toMatchTextContent("from chcp 437 to (chcp 437) >nul 2>&1")
  })

  it("shows the exact value Undo restores, and Undo offers the fix again", async () => {
    await openInbox()
    desktopWindow.autorun(demoAutoRunSilenced)

    await expect.element(autorun()).toMatchTextContent("Undo puts this value back exactly")
    await expect.element(autorun().getByText("chcp 65001", { exact: true })).toBeVisible()
    await autorun().getByRole("button", { name: "Undo" }).click()

    await expect.element(autorun()).toMatchTextContent("The AutoRun is back as it was")
    await expect
      .element(autorun().getByRole("button", { name: "Silence cmd's AutoRun output" }))
      .toBeVisible()
  })
})
