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
  it("asks in a short title, says what they'd do and keeps the extras behind Review", async () => {
    const card = await openCard(demoInboxIds.grant, /Let @moth's team push branches/)

    await expect
      .element(card.getByRole("heading", { name: /Let @fox and @owl work without asking\?/ }))
      .toBeVisible()
    await expect
      .element(card)
      .toMatchTextContent(
        "They'd push their branches and open pull requests in acme/storefront without asking you each time. Merges and pushes to main still need you.",
      )
    await expect
      .element(card)
      .toMatchTextContent("Fox and owl each finish a piece of checkout today")
    await expect.element(card).toMatchTextContent("@moth also asked for 3 more things")
    await expect.element(card.getByRole("checkbox")).not.toBeInTheDocument()
    await expect.element(card.getByRole("switch")).not.toBeInTheDocument()
    await expect.element(card.getByRole("menuitem")).toHaveLength(4)
    await expect
      .element(card.getByRole("menuitem").first())
      .toMatchTextContent("Allow until they're done")
  })

  it("expands Review to the extras, unticked, each with why", async () => {
    const card = await openCard(demoInboxIds.grant, /Let @moth's team push branches/)
    await card.getByRole("button", { name: "Review" }).click()

    await expect.element(card).toMatchTextContent("Not included unless you tick them.")
    await expect.element(card).toMatchTextContent("This could do more than pushing")
    await expect.element(card).toMatchTextContent("This repo was just created or changed")
    await expect.element(card).toMatchTextContent("This remote was added recently and isn't yours")
    await expect.element(card.getByRole("checkbox")).toHaveLength(3)
    for (const box of card.getByRole("checkbox").elements())
      expect((box as HTMLInputElement).checked).toBe(false)
  })

  it("expands Details to who is covered, Include me and the Codex note", async () => {
    const card = await openCard(demoInboxIds.grant, /Let @moth's team push branches/)
    await card.getByRole("button", { name: "Details" }).click()

    await expect.element(card).toMatchTextContent("Includes teammates @moth adds later.")
    await expect.element(card.getByRole("switch", { name: "Include me (@moth) too" })).toBeVisible()
    await expect
      .element(card)
      .toMatchTextContent("@fox uses Codex: allowed commands run outside Codex's sandbox.")
  })

  it("makes the grant until they're done, and the list says so", async () => {
    const card = await openCard(demoInboxIds.grant, /Let @moth's team push branches/)
    await expect.element(grants()).not.toBeInTheDocument()
    await card.getByRole("menuitem", { name: /^Allow until they're done/ }).click()

    await expect.element(grants()).toMatchTextContent("@moth's team")
    await expect
      .element(grants())
      .toMatchTextContent("push branches, open and edit pull requests in acme/storefront")
    await expect.element(grants()).toMatchTextContent(/until done/)
  })

  it("makes a grant for 1 hour with what was ticked under Review", async () => {
    const card = await openCard(demoInboxIds.grant, /Let @moth's team push branches/)
    await card.getByRole("button", { name: "Review" }).click()
    await card.getByRole("checkbox", { name: /acme\/storefront-ui/ }).click()
    await card.getByRole("menuitem", { name: /^Allow for 1 hour/ }).click()

    await expect.element(grants()).toMatchTextContent("acme/storefront, acme/storefront-ui")
    await expect.element(grants()).toMatchTextContent(/1 hour · \d+ min left/)
  })

  it("dismisses on Decline and makes no grant", async () => {
    const card = await openCard(demoInboxIds.grant, /Let @moth's team push/)
    await card.getByRole("menuitem", { name: /^Decline/ }).click()

    await expect.element(grants()).not.toBeInTheDocument()
  })
})

describe("A terminal's approval card", () => {
  it("names the commands as code, the open-ended one as a warning, and allows them for the hour until revoked", async () => {
    const card = await openCard(demoInboxIds.approval, /Can I run these without asking/)

    await expect
      .element(card)
      .toMatchTextContent("@moth would run these without asking you each time:")
    await expect.element(card).toMatchTextContent("uberepo check links")
    await expect.element(card).toMatchTextContent("could be followed by anything")
    await card.getByRole("menuitem", { name: /^Allow for 1 hour/ }).click()

    await expect.element(grants()).toMatchTextContent("@moth")
    await expect.element(grants()).toMatchTextContent(/1 hour · \d+ min left/)

    await grants()
      .getByRole("button", { name: /^Revoke the grant to @moth/ })
      .click()
    await expect.element(grants()).not.toBeInTheDocument()
  })

  it("offers until it's done, 1 hour, Decline and the terminal", async () => {
    const card = await openCard(demoInboxIds.approval, /Can I run these without asking/)

    await expect.element(card.getByRole("menuitem")).toHaveLength(4)
    await expect
      .element(card.getByRole("menuitem").first())
      .toMatchTextContent("Allow until it's done")
    await card.getByRole("menuitem", { name: /^Allow until it's done/ }).click()
    await expect.element(grants()).toMatchTextContent("until done")
  })
})
