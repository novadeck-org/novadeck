import { afterEach } from "vitest"
import { page, userEvent } from "vitest/browser"

import { windowMenu } from "../support/companions"
import { openMessagesDemo } from "../support/messages"
import { pinPointer } from "../support/pointer"
import {
  currentSessionName,
  expectCurrentSession,
  newSessionName,
  pressNewSession,
  savedSession,
} from "../support/sessions"
import {
  expectSelected,
  literal,
  sidebarPanel,
  terminalTab,
  terminalTabNames,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

// Moving a terminal to another session of its project, in the messages demo, where Checkout
// implementation leads Checkout review and Dev server is in no team. The demo has one
// session, so a spec makes the others, which are empty, and comes back to the first.

afterEach(async () => {
  // A drag a failed spec left held would carry into the next.
  await pinPointer("release")
})

const lead = "Checkout implementation"
const worker = "Checkout review"

// A menu lists eight sessions before "All sessions…".
const listed = 8

/** Opens the demo with `extra` empty sessions beside its own; returns their names, the open one first. */
const openWithSessions = async (extra = 1): Promise<{ home: string; others: string[] }> => {
  await openMessagesDemo()
  await sidebarPanel("Sessions").click()
  const home = await currentSessionName()
  const others: string[] = []
  let latest = home
  for (let made = 0; made < extra; made++) {
    // One session after another, each made while the last is open.
    // eslint-disable-next-line no-await-in-loop -- As above.
    await pressNewSession()
    // A new session shows the Terminals panel.
    // eslint-disable-next-line no-await-in-loop -- As above.
    await sidebarPanel("Sessions").click()
    // eslint-disable-next-line no-await-in-loop -- As above.
    latest = await newSessionName(latest)
    others.push(latest)
  }
  await savedSession(home).click()
  await expectCurrentSession(home)
  await sidebarPanel("Terminals").click()
  return { home, others }
}

const named = (name: string) => new RegExp(`^${literal(name)}`)

/** Opens a terminal's menu and its "Move to session" submenu. */
const moveMenu = async (name: string, entry = "Move to session") => {
  const menu = await windowMenu(name)
  await menu.getByRole("menuitem", { name: entry, exact: true }).click()
}

const toast = () => page.getByText(/ moved to .*, still running/)
// A press on one of the moved toast's buttons, until it takes. A press within a moment of the
// stack moving does nothing, and the demo's Inbox toasts keep landing and moving it; they also
// crowd the moved one back where the pointer can't reach, so its button is pressed itself.
const pressToast = async (name: string, taken: () => boolean): Promise<void> => {
  await expect
    .poll(
      () => {
        if (taken()) return true
        ;[...document.querySelectorAll<HTMLButtonElement>(".move-toast button")]
          .find((button) => button.textContent === name)
          ?.click()
        return false
      },
      { interval: 700, timeout: 15_000 },
    )
    .toBe(true)
}
const strip = (name: string) => page.getByRole("status").filter({ hasText: `Move ${name} to…` })

const center = (element: Element) => {
  const box = element.getBoundingClientRect()
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
}
const atTab = (name: string) => center(terminalTab(name).element())
// Free space in the view, well out of the list.
const away = { x: 800, y: 450 }
const atRail = () => center(document.getElementById("sessions-toggle")!)
// A session's button while the panel picks where a terminal goes.
const pickRow = (name: string) =>
  page.getByRole("button", { name: `Move here: ${name}`, exact: true })

describe("Moving a terminal to another session", () => {
  context("from its menu", () => {
    it("moves it there, with a toast that takes it back and one that goes there", async () => {
      const { others } = await openWithSessions()
      await moveMenu("Dev server")
      await page.getByRole("menuitem", { name: named(others[0]!) }).click()
      await expect.element(terminalTab("Dev server")).not.toBeInTheDocument()
      await expect.element(toast()).toBeVisible()
      // The person stays where they are.
      expect(terminalTabNames()).toContain(lead)

      await pressToast("Undo", () => document.querySelector(".move-toast") === null)
      await expect.element(terminalTab("Dev server")).toBeVisible()

      await moveMenu("Dev server")
      await page.getByRole("menuitem", { name: named(others[0]!) }).click()
      await expect.element(terminalTab("Dev server")).not.toBeInTheDocument()
      await pressToast("Go there", () => document.querySelector(".move-toast") === null)
      await expectSelected("Dev server")
      expect(terminalTabNames()).not.toContain(lead)
    })

    it("asks a teammate whether it goes alone, and takes only it", async () => {
      const { others } = await openWithSessions()
      await moveMenu(worker)
      await page.getByRole("menuitem", { name: named(others[0]!) }).click()
      await expect.element(page.getByText(/Move @crow out of @moth's team\?/)).toBeVisible()
      await page.getByRole("button", { name: "Move @crow alone" }).click()
      await expect.element(terminalTab(worker)).not.toBeInTheDocument()
      await expect.element(terminalTab(lead)).toBeVisible()
    })

    it("takes the whole team, its lead at the top, when told to", async () => {
      const { others } = await openWithSessions()
      await moveMenu(worker)
      await page.getByRole("menuitem", { name: named(others[0]!) }).click()
      await page.getByRole("button", { name: "Move all 2" }).click()
      await expect.element(terminalTab(worker)).not.toBeInTheDocument()
      await expect.element(terminalTab(lead)).not.toBeInTheDocument()
      expect(terminalTabNames()).toContain("Dev server")
    })

    it("keeps the teammate where it is when the question is cancelled", async () => {
      const { others } = await openWithSessions()
      await moveMenu(worker)
      await page.getByRole("menuitem", { name: named(others[0]!) }).click()
      await page.getByRole("button", { name: "Cancel" }).click()
      await expect.element(terminalTab(worker)).toBeVisible()
      expect(toast().query()).toBeNull()
    })
  })

  context("picking among all the sessions", () => {
    it("picks from the Sessions panel by keyboard, and Escape gives up and puts the sidebar back", async () => {
      await openWithSessions(listed + 1)
      await moveMenu("Dev server")
      const all = page.getByRole("menuitem", { name: "All sessions…", exact: true })
      await expect.element(all).toBeVisible()
      await userEvent.keyboard("{End}{Enter}")
      await expect.element(strip("Dev server")).toBeVisible()
      await expect.element(sidebarPanel("Sessions")).toBeChecked()

      await userEvent.keyboard("{Escape}")
      await expect.element(strip("Dev server")).not.toBeInTheDocument()
      await expect.element(sidebarPanel("Terminals")).toBeChecked()
      await expect.element(terminalTab("Dev server")).toBeVisible()
      expect(toast().query()).toBeNull()
    })

    it("moves the terminal to the session picked there", async () => {
      const { others } = await openWithSessions(listed + 1)
      await moveMenu("Dev server")
      const all = page.getByRole("menuitem", { name: "All sessions…", exact: true })
      await expect.element(all).toBeVisible()
      await userEvent.keyboard("{End}{Enter}")
      await expect.element(strip("Dev server")).toBeVisible()
      // The panel's rows are still settling, so the row is pressed itself.
      const row = pickRow(others.at(-1)!)
      await expect.element(row).toBeVisible()
      const button = row.element() as HTMLElement
      button.click()
      await expect.element(toast()).toBeVisible()
      await expect.element(sidebarPanel("Terminals")).toBeChecked()
      await expect.element(terminalTab("Dev server")).not.toBeInTheDocument()
    })
  })

  context("by dragging its tab", () => {
    // Once the pointer is let go, the page is read from its DOM: a locator's check in those
    // moments can stall for many seconds after a drop, while the page itself is long settled.
    const present = (name: string): boolean => terminalTabNames().includes(name)

    it("pulls it free, opens the Sessions panel over its button, and moves it to the row it drops on", async () => {
      const { others } = await openWithSessions()
      try {
        await pinPointer("press", atTab("Dev server"))
        // Out of the list far enough to break free, then over the rail's button.
        await pinPointer("move", away)
        await pinPointer("move", atRail())
        // dnd-kit takes a move on the next frame, so the pointer is moved on to bring it.
        await pinPointer("move", { x: atRail().x + 2, y: atRail().y + 1 })
        // Held over the button, the panel opens to pick where it goes.
        await expect.element(strip("Dev server")).toBeVisible()
        await pinPointer("move", center(pickRow(others[0]!).element()))
        await expect
          .poll(() =>
            pickRow(others[0]!)
              .element()
              .closest("[data-workspace-session]")
              ?.getAttribute("data-move-target"),
          )
          .toBe("over")
        await pinPointer("release")
      } finally {
        await pinPointer("release")
      }
      await expect
        .poll(() => /Dev server moved to/.test(document.body.textContent ?? ""))
        .toBe(true)
      await expect
        .poll(() => sidebarPanel("Terminals").element().getAttribute("aria-checked"))
        .toBe("true")
      await expect.poll(() => present("Dev server")).toBe(false)
    })

    it("keeps the list's order when let go free over nothing", async () => {
      await openWithSessions()
      const before = terminalTabNames()
      try {
        await pinPointer("press", atTab("Tests"))
        await pinPointer("move", away)
        await pinPointer("release")
      } finally {
        await pinPointer("release")
      }
      await expect.poll(() => document.querySelector("[data-pull]")).toBeNull()
      expect(terminalTabNames()).toEqual(before)
      expect(toast().query()).toBeNull()
    })
  })
})
