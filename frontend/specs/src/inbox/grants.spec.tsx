import { demoInboxIds } from "@novadeck/demo/inbox/fixtures"
import { beforeEach } from "vitest"
import { page } from "vitest/browser"

import { desktopWindow, forgetDesktopWindow } from "../support/backend"
import { openWorkspace, sidebarPanel, skipWelcome } from "../support/workspace"
import { describe, expect, it } from "../test"

// The person's grants (#587, #588) on the demo backend: a lead's Grant card and a terminal's
// approval card in the Inbox, the Grants section they make, and Revoke. The cards are the debug
// panel's fixtures; the spec's app (`&desktop=on`) lets it add them as the debug panel does.
const route =
  "/projects/storefront/sessions/initial/focus?terminal=storefront-initial-01&desktop=on"

beforeEach(forgetDesktopWindow)

const inboxRow = (subject: RegExp | string) =>
  page.getByRole("list", { name: "Messages from your agents" }).getByRole("button", {
    name: typeof subject === "string" ? new RegExp(subject) : subject,
  })
const grants = () => page.getByRole("region", { name: "Grants" })

const openCard = async (
  id: string,
  subject: RegExp,
): Promise<ReturnType<typeof page.getByRole>> => {
  await openWorkspace(route)
  await skipWelcome()
  await sidebarPanel("Inbox").click()
  desktopWindow.arrive(id)
  await inboxRow(subject).click()
  return page.getByRole("dialog")
}

describe("A lead's Grant card", () => {
  it("shows what it would allow and to whom, in Novadeck's words, and Grant makes the grant", async () => {
    const card = await openCard(demoInboxIds.grant, /Let @moth's team push branches/)

    await expect
      .element(card)
      .toMatchTextContent(/Push a named branch to acme\/storefront \(no force/)
    await expect
      .element(card)
      .toMatchTextContent("@moth's teammates, now and later (now: @fox, @owl)")
    await expect.element(card).toMatchTextContent("added remote")
    await expect.element(card).toMatchTextContent("followed by anything")
    await expect.element(card).toMatchTextContent("Codex's sandbox")
    await expect.element(grants()).not.toBeInTheDocument()

    // The added remote stays unticked; untick another repo and pick a day.
    await card.getByRole("checkbox", { name: /acme\/storefront-ui/ }).click()
    await card.getByRole("radio", { name: "24 h" }).click({ force: true })
    await card.getByRole("menuitem", { name: /^Grant/ }).click()

    await expect.element(grants()).toMatchTextContent("@moth's team")
    await expect
      .element(grants())
      .toMatchTextContent("push branches, open and edit pull requests in acme/storefront")
    await expect.element(grants()).toMatchTextContent(/(24h|23h \d+m) left/)
  })

  it("dismisses on Decline and makes no grant", async () => {
    const card = await openCard(demoInboxIds.grant, /Let @moth's team push/)
    await card.getByRole("menuitem", { name: /^Decline/ }).click()

    await expect.element(grants()).not.toBeInTheDocument()
  })
})

describe("A terminal's approval card", () => {
  it("lets the terminal run its commands for an hour once approved, until revoked", async () => {
    const card = await openCard(demoInboxIds.approval, /May I ship the docs/)

    await expect
      .element(card)
      .toMatchTextContent("Lets @moth run, without asking again, for 1 hour:")
    await expect.element(card).toMatchTextContent("uberepo check links … followed by anything")
    await card.getByRole("menuitem", { name: /^Approve/ }).click()

    await expect.element(grants()).toMatchTextContent("@moth")
    await expect.element(grants()).toMatchTextContent(/(1h( \dm)?|\d+m) left/)

    await grants()
      .getByRole("button", { name: /^Revoke the grant to @moth/ })
      .click()
    await expect.element(grants()).not.toBeInTheDocument()
  })
})
