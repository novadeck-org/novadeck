import { page } from "vitest/browser"

import { approvals } from "../support/backend"
import { expectStaysAbsent, openWorkspace, press } from "../support/workspace"
import { describe, expect, it } from "../test"

// What an agent asks the person to allow, in a modal over the workspace: closing a terminal,
// leading one, or running a command. The spec's backend (`&approvals=on`) takes the asks the
// spec makes for an agent, and keeps the person's answers.

// @moth's "Checkout implementation" asks about @crow's "Checkout review", and the other way.
const moth = "storefront-initial-01"
const crow = "storefront-initial-04"

const open = (): Promise<void> => openWorkspace("/?approvals=on")
const asking = (name: RegExp) => page.getByRole("alertdialog", { name })
const closing = () => asking(/^Let @moth close @crow\?$/)
const leading = () => asking(/^Let @crow lead @moth\?$/)

describe("An agent's ask for the person's approval", () => {
  it("asks with declining focused, and declines on Escape", async () => {
    await open()
    approvals.ask({ requestId: "close-1", from: moth, terminalId: crow, action: { type: "close" } })

    await expect.element(closing()).toBeVisible()
    await expect.element(closing().getByRole("button", { name: "Keep open" })).toHaveFocus()
    await press("{Escape}")

    await expect.element(closing()).not.toBeInTheDocument()
    expect(approvals.answers()).toEqual([{ requestId: "close-1", approved: false }])
  })

  it("holds yes back a moment, then asks the next one waiting on its own", async () => {
    await open()
    approvals.ask({ requestId: "close-1", from: moth, terminalId: crow, action: { type: "close" } })
    approvals.ask({
      requestId: "lead-1",
      from: crow,
      terminalId: moth,
      action: { type: "lead", brief: "Review the checkout." },
    })

    const yes = closing().getByRole("button", { name: "Close terminal" })
    await expect.element(yes).toBeVisible()
    // Keys typed ahead can't take it: yes is held back as the ask shows.
    await expect.element(yes).toBeDisabled()
    await expect.element(yes).toBeEnabled()
    await yes.click()

    await expect.element(leading()).toBeVisible()
    expect(approvals.answers()).toEqual([{ requestId: "close-1", approved: true }])
    await expect.element(leading().getByText("Review the checkout.")).toBeVisible()
    await expect.element(leading().getByRole("button", { name: "Decline" })).toHaveFocus()
    // Its own Escape: the first ask's answer doesn't carry over to it.
    await press("{Escape}")

    await expectStaysAbsent(page.getByRole("alertdialog"))
    expect(approvals.answers()).toEqual([
      { requestId: "close-1", approved: true },
      { requestId: "lead-1", approved: false },
    ])
  })
})
