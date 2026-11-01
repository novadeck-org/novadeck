import {
  demoAutoRunManual,
  demoAutoRunOffer,
  demoAutoRunSilenced,
  demoInboxIds,
} from "@novadeck/demo/inbox/fixtures"
import { beforeEach } from "vitest"
import { page } from "vitest/browser"

import { desktopWindow, forgetDesktopWindow } from "../support/backend"
import { closePreferences, openPreferences, preferencesDialog } from "../support/keyboard"
import { openWorkspace, sidebarPanel, skipWelcome } from "../support/workspace"
import { describe, expect, it } from "../test"

// Command Prompt's startup script (cmd's AutoRun, approvals-design.md Appendix F) on the demo
// backend: the Inbox's line and its small confirm, the Antigravity Grant card's own line, and
// Preferences' row with Undo. The states are the debug panel's AutoRun actions; the spec's app
// (`&desktop=on`) lets it set them as the panel does.
const route =
  "/projects/storefront/sessions/initial/focus?terminal=storefront-initial-01&desktop=on"

beforeEach(forgetDesktopWindow)

const line = () => page.getByRole("region", { name: "Command Prompt startup output" })
const confirm = () => page.getByRole("alertdialog")

const openInbox = async (): Promise<void> => {
  await openWorkspace(route)
  await skipWelcome()
  await sidebarPanel("Inbox").click()
}

describe("The Command Prompt line in the Inbox", () => {
  it("is not there where Command Prompt prints nothing", async () => {
    await openInbox()

    await expect.element(line()).not.toBeInTheDocument()
  })

  it("says Antigravity needs one fix, and Fix opens a small confirm with the details collapsed", async () => {
    await openInbox()
    desktopWindow.autorun(demoAutoRunOffer)

    await expect
      .element(line())
      .toMatchTextContent("Antigravity on this PC needs one fix to use approvals")
    await line().getByRole("button", { name: "Fix" }).click()

    await expect
      .element(confirm())
      .toMatchTextContent("Antigravity can't use your approvals on this computer")
    await expect.element(confirm()).toMatchTextContent("Novadeck can hide that script's output")
    await expect.element(confirm()).toMatchTextContent("you can undo this anytime")
    await expect.element(confirm()).not.toHaveTextContent("HKEY_CURRENT_USER")
    await confirm().getByRole("button", { name: "details" }).click()
    await expect.element(confirm()).toMatchTextContent("HKEY_CURRENT_USER")
    await expect.element(confirm()).toMatchTextContent("chcp 65001")
    await expect.element(confirm()).toMatchTextContent("(chcp 65001) >nul 2>&1")
    await expect.element(confirm()).toMatchTextContent("every Command Prompt window")
    await expect.element(confirm()).toMatchTextContent("prompts, colours, messages")
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
    await line().getByRole("button", { name: "Fix" }).click()
    await confirm().getByRole("button", { name: "details" }).click()

    await expect.element(confirm()).toMatchTextContent("chcp\\u{200B} 65001")
  })

  it("hides the output on Hide it, and says so with Undo beside it", async () => {
    await openInbox()
    desktopWindow.autorun(demoAutoRunOffer)
    await line().getByRole("button", { name: "Fix" }).click()
    await confirm().getByRole("button", { name: "Hide it" }).click()

    await expect.element(confirm()).not.toBeInTheDocument()
    await expect
      .element(line())
      .toMatchTextContent("Command Prompt startup output hidden for Antigravity")
    await expect.element(line()).toMatchTextContent("Command Prompt prints nothing at startup now")
    await expect.element(line().getByRole("button", { name: "Undo" })).toBeVisible()
  })

  it("goes away on Not now", async () => {
    await openInbox()
    desktopWindow.autorun(demoAutoRunOffer)
    await line().getByRole("button", { name: "Fix" }).click()
    await confirm().getByRole("button", { name: "Not now" }).click()

    await expect.element(line()).not.toBeInTheDocument()
  })

  it("gives the step in words, and never a command line, where the machine's script prints", async () => {
    await openInbox()
    desktopWindow.autorun(demoAutoRunManual)
    await line().getByRole("button", { name: "Fix" }).click()

    await expect
      .element(confirm())
      .toMatchTextContent("the machine's (HKLM), which needs an administrator")
    await confirm().getByRole("button", { name: "details" }).click()
    await expect.element(confirm()).toMatchTextContent("in regedit, as an administrator")
    await expect.element(confirm()).toMatchTextContent("(chcp 65001) >nul 2>&1")
    await expect.element(confirm().getByRole("button", { name: "Hide it" })).not.toBeInTheDocument()
    await expect.element(confirm()).not.toHaveTextContent("reg add")
  })

  it("gives the machine's step too once hidden, where the machine's script holds a value", async () => {
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
      .element(line())
      .toMatchTextContent("Command Prompt still prints: the machine's startup script (HKLM) does")
    await line().getByRole("button", { name: "See how" }).click()
    await confirm().getByRole("button", { name: "details" }).click()
    await expect.element(confirm()).toMatchTextContent("in regedit, as an administrator")
    await expect.element(confirm()).toMatchTextContent("from chcp 437 to (chcp 437) >nul 2>&1")
  })

  it("puts it back on Undo, and offers the fix again", async () => {
    await openInbox()
    desktopWindow.autorun(demoAutoRunSilenced)
    await line().getByRole("button", { name: "Undo" }).click()

    await expect.element(line()).toMatchTextContent("The startup script is back as it was")
    await expect.element(line().getByRole("button", { name: "Fix" })).toBeVisible()
  })
})

describe("An Antigravity team's Grant card", () => {
  it("has the line and its Fix in Details while Command Prompt prints", async () => {
    await openWorkspace(route)
    await skipWelcome()
    await sidebarPanel("Inbox").click()
    desktopWindow.arrive(demoInboxIds.grantAgy)
    desktopWindow.autorun(demoAutoRunOffer)
    await page
      .getByRole("list", { name: "Messages from your agents" })
      .getByRole("button", { name: /Let @fox's team push branches/ })
      .click()
    const card = page.getByRole("dialog")
    await card.getByRole("button", { name: "Details" }).click()

    await expect
      .element(card)
      .toMatchTextContent("Antigravity on this PC needs one fix to use this grant")
    await expect.element(card).toMatchTextContent("@elk uses Antigravity")
    await card.getByRole("button", { name: "Fix" }).click()
    await expect
      .element(confirm())
      .toMatchTextContent("Antigravity can't use your approvals on this computer")
  })
})

describe("Preferences' Command Prompt row", () => {
  it("is there while it is hidden, with Undo, and the value Undo restores behind Details", async () => {
    await openInbox()
    desktopWindow.autorun(demoAutoRunSilenced)
    await openPreferences()

    const row = preferencesDialog().getByRole("list", { name: "Command Prompt startup output" })
    await expect
      .element(row)
      .toMatchTextContent("Command Prompt startup output hidden for Antigravity")
    await row.getByText("Details").click()
    await expect.element(row).toMatchTextContent("chcp 65001")
    await row.getByRole("button", { name: "Undo" }).click()

    await expect.element(row).not.toBeInTheDocument()
    await closePreferences()
  })
})
