import { onTestFinished } from "vitest"
import { page, userEvent } from "vitest/browser"

import { settled } from "../support/canvas"
import { expectFocusWithin, recentSwitcher } from "../support/keyboard"
import { pinPointer } from "../support/pointer"
import { workspaceSwitcher } from "../support/sessions"
import { sidebarRenameField, tabAction } from "../support/terminals"
import {
  expectStaysAbsent,
  isMac,
  openWorkspace,
  skipWelcome,
  terminal,
  clickInto,
  commandInput,
  press,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

const pinsBar = () => page.getByRole("group", { name: "Pinned projects" })
// The words on the bar saying where to drop a project dragged from the switcher.
const dropHint = (): HTMLElement => document.querySelector<HTMLElement>(".pins-bar-drop-hint")!
const pin = (name: string) => pinsBar().getByRole("button", { name: new RegExp(`${name}$`) })
// The projects a spec pins, in order, kept as an earlier client's arrangement.
const arrange = (pinned: string[]): void =>
  localStorage.setItem("novadeck.project-arrangement", JSON.stringify({ order: pinned, pinned }))
const switcherRow = (name: string) =>
  page
    .getByRole("dialog", { name: "Switch workspace" })
    .getByRole("button", { name: new RegExp(`^${name}`) })
// Presses Escape once the bar is dragging the pin a project handed over, before the
// drag is let go.
const escapeOnceHandedOver = (name: string): void => {
  const moved = (): void => {
    if (!document.querySelector(`.pin[data-pin="${name}"][data-dragging="true"]`)) return
    window.removeEventListener("pointermove", moved, true)
    // After the bar has followed this move.
    setTimeout(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    )
  }
  window.addEventListener("pointermove", moved, true)
}

// The switcher's projects as it lists them, while it is open.
const switcherOrder = () =>
  [
    ...(page
      .getByRole("dialog", { name: "Switch workspace" })
      .query()
      ?.querySelectorAll(".workspace-switcher-project strong") ?? []),
  ].map((name) => name.textContent)

// ⌘ and the digit on a Mac, Ctrl+Shift and the digit elsewhere.
const pressDigit = (digit: number): Promise<void> =>
  press(isMac() ? `{Meta>}${digit}{/Meta}` : `{Control>}{Shift>}${digit}{/Shift}{/Control}`)
// docs-site, then api-service, pinned.
const pinInOrder = (): void => arrange(["docs-site", "api-service"])

const digitKeydown = (
  digit: number,
  init: KeyboardEventInit = {},
  target: Element = document.body,
): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", {
    // Shift turns a digit into its symbol, as US keys do.
    key: isMac() ? String(digit) : (")!@#$%^&*("[digit] ?? ""),
    code: `Digit${digit}`,
    ctrlKey: !isMac(),
    shiftKey: !isMac(),
    metaKey: isMac(),
    bubbles: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

describe("pinned project shortcuts", () => {
  context("when pressing the pin's number", () => {
    it("switches to that pinned project, in the order they are pinned", async () => {
      pinInOrder()
      await openWorkspace()
      await expect.element(workspaceSwitcher()).toHaveTextContent("storefront")

      await pressDigit(2)
      await expect.element(workspaceSwitcher()).toHaveTextContent("api-service")

      await pressDigit(1)
      await expect.element(workspaceSwitcher()).toHaveTextContent("docs-site")
    })

    it("works from a terminal input without typing the digit there", async () => {
      pinInOrder()
      await openWorkspace()
      const input = commandInput("Checkout implementation").element()
      await clickInto("Checkout implementation")

      // The key is ours, so it never reaches the terminal's own handlers.
      expect(digitKeydown(2, {}, input).defaultPrevented).toBe(true)
      await expect.element(workspaceSwitcher()).toHaveTextContent("api-service")
      await pressDigit(1)
      await expect.element(workspaceSwitcher()).toHaveTextContent("docs-site")
    })

    it("works from the open project switcher, and closes it", async () => {
      pinInOrder()
      await openWorkspace()
      await workspaceSwitcher().click()
      await expect.element(page.getByRole("dialog")).toBeVisible()

      await pressDigit(2)

      await expect.element(workspaceSwitcher()).toHaveTextContent("api-service")
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument()
    })

    it("works from the terminal switcher, and closes it", async () => {
      pinInOrder()
      await openWorkspace()
      await terminal("Checkout implementation")
        .getByRole("button", { name: "Switch terminal" })
        .click()
      await expectFocusWithin(recentSwitcher())

      await pressDigit(2)

      await expect.element(workspaceSwitcher()).toHaveTextContent("api-service")
      await expect.element(recentSwitcher()).not.toBeInTheDocument()
    })

    // On macOS the pin's chord is ⌘ and a digit, so the Ctrl held for the switcher isn't
    // part of it there.
    it.skipIf(isMac())("works from the terminal switcher held open with Ctrl+Tab", async () => {
      pinInOrder()
      await openWorkspace()
      await press("{Control>}{Tab}")
      await expect.element(recentSwitcher()).toBeVisible()

      await press("{Shift>}2{/Shift}")

      await expect.element(workspaceSwitcher()).toHaveTextContent("api-service")
      await expect.element(recentSwitcher()).not.toBeInTheDocument()
      await press("{/Control}")
    })

    it("keeps the key from the terminal even when the pin is already the current project", async () => {
      pinInOrder()
      await openWorkspace()
      await pressDigit(1)
      await expect.element(workspaceSwitcher()).toHaveTextContent("docs-site")

      expect(digitKeydown(1).defaultPrevented).toBe(true)
      expect(digitKeydown(1, { repeat: true }).defaultPrevented).toBe(true)
      await expect.element(workspaceSwitcher()).toHaveTextContent("docs-site")
    })

    it("does not switch again on a held key", async () => {
      pinInOrder()
      await openWorkspace()

      expect(digitKeydown(2).defaultPrevented).toBe(true)
      await expect.element(workspaceSwitcher()).toHaveTextContent("api-service")
      expect(digitKeydown(1, { repeat: true }).defaultPrevented).toBe(true)
      await expect.element(workspaceSwitcher()).toHaveTextContent("api-service")
    })

    it("leaves the key to a tab's rename field", async () => {
      pinInOrder()
      await openWorkspace()
      await tabAction("Rename Dev server").click()
      await expect.element(sidebarRenameField("Dev server")).toHaveFocus()

      const event = digitKeydown(2, {}, sidebarRenameField("Dev server").element())

      expect(event.defaultPrevented).toBe(false)
      await expect.element(workspaceSwitcher()).toHaveTextContent("storefront")
    })

    it("leaves the project as it is behind a confirmation", async () => {
      pinInOrder()
      await openWorkspace()
      await workspaceSwitcher().click()
      await page.getByRole("button", { name: "Remove storefront" }).click({ force: true })
      const confirm = page.getByRole("alertdialog", { name: "Remove “storefront”?" })
      await expect.element(confirm).toBeVisible()

      await pressDigit(2)

      await expect.element(confirm).toBeVisible()
      // The workspace behind the confirmation is hidden from the accessibility tree.
      await expect
        .element(page.getByRole("button", { name: "Switch workspace", includeHidden: true }))
        .toHaveTextContent("storefront")
    })
  })

  context("when there is no such pin", () => {
    it("changes nothing and leaves the key, held or not, to the terminal", async () => {
      pinInOrder()
      await openWorkspace()
      await clickInto("Checkout implementation")
      const input = commandInput("Checkout implementation").element()

      expect(digitKeydown(3, {}, input).defaultPrevented).toBe(false)
      expect(digitKeydown(9, {}, input).defaultPrevented).toBe(false)
      expect(digitKeydown(3, { repeat: true }, input).defaultPrevented).toBe(false)

      await expect.element(workspaceSwitcher()).toHaveTextContent("storefront")
      await expect.element(commandInput("Checkout implementation")).toHaveFocus()
    })

    it("leaves every press and repeat alone when nothing is pinned", async () => {
      await openWorkspace()

      expect(digitKeydown(1).defaultPrevented).toBe(false)
      expect(digitKeydown(8, { repeat: true }).defaultPrevented).toBe(false)
      await expect.element(workspaceSwitcher()).toHaveTextContent("storefront")
    })
  })
})

describe("A pinned project", () => {
  it("shows in the bar under the header, and the switcher's dot leaves it out", async () => {
    // Pinned, docs-site shows in the bar, its agent asking a question; the dot leaves it
    // out, so it shows the next most pressing: api-service's waiting agents.
    arrange(["docs-site"])
    await openWorkspace("/?demo=agents")
    await skipWelcome()
    await expect.element(pin("docs-site")).toHaveAttribute("aria-description", "Asks a question")
    await expect.element(workspaceSwitcher()).toHaveAttribute("data-project-status", "unblock")

    // Switching to it keeps its pin in place, marked current; the others still wait in
    // the dot.
    await pin("docs-site").click()
    await expect.element(workspaceSwitcher()).toHaveTextContent("docs-site")
    await expect.element(pin("docs-site")).toHaveAttribute("aria-current", "true")
    await expect.element(workspaceSwitcher()).toHaveAttribute("data-project-status")
  })

  it("is absent with no pins, and appears when pinning from the switcher menu", async () => {
    await openWorkspace()
    await expect.element(pinsBar()).not.toBeInTheDocument()

    await workspaceSwitcher().click()
    await page.getByRole("button", { name: "Pin api-service" }).click()

    await expect.element(pin("api-service")).toBeVisible()
    await expect.element(pin("api-service")).toHaveTextContent("1api-service")
  })

  context("reordered", () => {
    const pinNames = () =>
      pinsBar()
        .getByRole("button")
        .elements()
        .map((button) => button.textContent)

    it("by dragging a pin along the bar, which the switcher and the numbers follow", async () => {
      arrange(["storefront", "api-service", "mobile-app"])
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      expect(pinNames()).toEqual(["1storefront", "2api-service", "3mobile-app"])

      const first = pin("storefront")
      const last = pin("mobile-app")
      const from = first.element().getBoundingClientRect()
      const to = last.element().getBoundingClientRect()
      await userEvent.dragAndDrop(first, last, {
        sourcePosition: { x: from.width / 2, y: from.height / 2 },
        targetPosition: { x: to.width - 4, y: to.height / 2 },
        steps: 12,
      })
      await expect.poll(pinNames).toEqual(["1api-service", "2mobile-app", "3storefront"])
      await expect
        .element(pin("storefront"))
        .toHaveAttribute(
          "aria-keyshortcuts",
          isMac() ? "Meta+3 Alt+ArrowLeft" : "Control+Shift+3 Alt+ArrowLeft",
        )
      // Still pinned, and the switcher lists them in that order.
      await workspaceSwitcher().click()
      const listed = page
        .getByRole("dialog", { name: "Switch workspace" })
        .getByRole("button", { name: /^(storefront|api-service|mobile-app)/ })
        .elements()
        .map((button) => button.querySelector("strong")?.textContent)
      expect(listed.slice(0, 3)).toEqual(["api-service", "mobile-app", "storefront"])
    })

    it("unpins a pin dragged off the bar and let go there", async () => {
      arrange(["storefront", "api-service", "mobile-app"])
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      const from = pin("api-service").element().getBoundingClientRect()
      await userEvent.dragAndDrop(pin("api-service"), page.elementLocator(document.body), {
        sourcePosition: { x: from.width / 2, y: from.height / 2 },
        targetPosition: { x: from.left + from.width / 2, y: from.bottom + 160 },
        steps: 12,
        force: true,
      })

      await expect.poll(pinNames).toEqual(["1storefront", "2mobile-app"])
    })

    it("only by a drag: a click still switches", async () => {
      arrange(["storefront", "api-service", "mobile-app"])
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      await pin("api-service").click()
      await expect.element(pin("api-service")).toHaveAttribute("aria-current", "true")
      expect(pinNames()).toEqual(["1storefront", "2api-service", "3mobile-app"])
    })

    it("by Alt and the arrows, with the focus kept, and never out of the bar", async () => {
      arrange(["storefront", "api-service", "mobile-app"])
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      pin("storefront").element().focus()
      await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}")
      await expect.poll(pinNames).toEqual(["1api-service", "2storefront", "3mobile-app"])
      await expect.element(pin("storefront")).toHaveFocus()
      await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}")
      await expect.poll(pinNames).toEqual(["1api-service", "2mobile-app", "3storefront"])
      // The last one stays pinned.
      await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}")
      expect(pinNames()).toEqual(["1api-service", "2mobile-app", "3storefront"])
      await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}")
      await expect.poll(pinNames).toEqual(["1api-service", "2storefront", "3mobile-app"])
      await expect.element(pin("storefront")).toHaveFocus()
    })
  })

  context("dragged from the switcher menu", () => {
    // Drags a project's row out of the open menu and lets it go at a point on the screen:
    // by default on the bar under the header, past its pins and the menu.
    // More steps leave more moves after the handoff, for what shows as the menu closes.
    const dragOut = async (
      name: string,
      to?: { x: number; y: number },
      steps = 16,
    ): Promise<void> => {
      // Once the menu has opened in full: a drag begun while it still slides in starts
      // off the row, and the drag never takes (seen once on a macOS runner).
      const from = await settled(() => switcherRow(name).element().getBoundingClientRect())
      const header = workspaceSwitcher().element().closest("header")!.getBoundingClientRect()
      await userEvent.dragAndDrop(switcherRow(name), page.elementLocator(document.body), {
        sourcePosition: { x: 40, y: from.height / 2 },
        targetPosition: to ?? { x: window.innerWidth - 80, y: header.bottom + 16 },
        steps,
        force: true,
      })
    }

    it("pins it where it is let go, after the pins it passes", async () => {
      arrange(["storefront", "api-service"])
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      await workspaceSwitcher().click()

      await dragOut("mobile-app")

      await expect.element(pin("mobile-app")).toHaveTextContent("3mobile-app")
      // The menu closed as the drag left it, handing the bar a pin; it lists it as pinned.
      await expect
        .element(page.getByRole("dialog", { name: "Switch workspace" }))
        .not.toBeInTheDocument()
      await workspaceSwitcher().click()
      await expect.element(switcherRow("mobile-app").getByLabelText("Pinned")).toBeInTheDocument()
    })

    it("opens an empty bar for the drag, and the project becomes the first pin", async () => {
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      await expect.element(pinsBar()).not.toBeInTheDocument()
      await workspaceSwitcher().click()

      await dragOut("docs-site")

      await expect.element(pin("docs-site")).toHaveTextContent("1docs-site")
    })

    it("says where to drop until the drag is let go, after the menu has closed", async () => {
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      await workspaceSwitcher().click()
      await expect
        .element(page.getByRole("dialog", { name: "Switch workspace" }))
        .toHaveAttribute("data-state", "open")
      const from = await settled(() => switcherRow("docs-site").element().getBoundingClientRect())
      const header = workspaceSwitcher().element().closest("header")!.getBoundingClientRect()
      try {
        await pinPointer("press", { x: from.left + 40, y: from.top + from.height / 2 })
        await pinPointer("move", { x: window.innerWidth - 80, y: header.bottom + 16 })
        // Observe the committed handoff while the pointer is still down, instead of a
        // capture-phase sample that may precede the original drag's end and menu commit.
        await expect
          .poll(() => ({
            menu:
              page.getByRole("dialog", { name: "Switch workspace" }).query()?.dataset.state ===
              "open",
            dragging:
              document.querySelector('.pin[data-pin="docs-site"][data-dragging="true"]') !== null,
            hint: dropHint().checkVisibility({ visibilityProperty: true }),
            target: document.querySelector('.pins-bar[data-receiving="true"]') !== null,
          }))
          .toEqual({ menu: false, dragging: true, hint: true, target: true })
      } finally {
        await pinPointer("release")
      }
      await expect.element(pin("docs-site")).toHaveTextContent("1docs-site")
      await expect.poll(() => dropHint().checkVisibility({ visibilityProperty: true })).toBe(false)
      expect(document.querySelector('.pins-bar[data-receiving="true"]')).toBeNull()
    })

    it("marks a bar with pins as a place to drop, its words after them", async () => {
      arrange(["storefront", "api-service"])
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      await workspaceSwitcher().click()
      let seen: {
        readonly hint: boolean
        readonly target: boolean
        readonly after: boolean
      } | null = null
      const moved = (): void => {
        if (!document.querySelector('.pin[data-pin="docs-site"][data-dragging="true"]')) return
        const last = pin("api-service").element().getBoundingClientRect()
        seen = {
          hint: dropHint().checkVisibility({ visibilityProperty: true }),
          target: document.querySelector('.pins-bar[data-receiving="true"]') !== null,
          after: dropHint().getBoundingClientRect().left >= last.right,
        }
      }
      window.addEventListener("pointermove", moved, true)

      await dragOut("docs-site")
      window.removeEventListener("pointermove", moved, true)

      expect(seen).toEqual({ hint: true, target: true, after: true })
      await expect.element(pin("docs-site")).toHaveTextContent("3docs-site")
      expect(document.querySelector('.pins-bar[data-receiving="true"]')).toBeNull()
    })

    it("keeps its words clear of the pins in a crowded bar", async () => {
      // Three pins in a narrow window, which the dragged one's slot fills: the words show
      // only after the last pin shown and that slot, or not at all.
      arrange(["storefront", "api-service", "mobile-app"])
      await page.viewport(620, 900)
      onTestFinished(() => page.viewport(1440, 900))
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      await workspaceSwitcher().click()
      const overlaps: string[] = []
      let sampled = 0
      const moved = (): void => {
        if (!document.querySelector('.pin[data-pin="docs-site"][data-dragging="true"]')) return
        sampled++
        if (!dropHint().checkVisibility({ visibilityProperty: true })) return
        const left = dropHint().getBoundingClientRect().left
        // The pins shown, and the slot the dragged one holds, where it lands.
        for (const shown of document.querySelectorAll<HTMLElement>(
          ".pin[data-dnd-placeholder], .pin:not([inert]):not([data-dragging])",
        ))
          if (shown.getBoundingClientRect().right > left) overlaps.push(shown.dataset.pin!)
      }
      window.addEventListener("pointermove", moved, true)

      await dragOut("docs-site")
      window.removeEventListener("pointermove", moved, true)

      expect(sampled).toBeGreaterThan(0)
      expect(overlaps).toEqual([])
    })

    it("still reorders the list when dragged to its top, with the bar behind it", async () => {
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      await workspaceSwitcher().click()
      await expect.poll(() => switcherOrder()[0]).toBeTruthy()
      const first = switcherOrder()[0]!
      // Where the list sits once the menu has opened in full: a point aimed at its top row
      // from before that lies above the list, which counts as out of it and hands the drag
      // to the bar.
      const top = await settled(() => switcherRow(first).element().getBoundingClientRect())
      await dragOut("docs-site", { x: top.left + 60, y: top.top + 6 })

      await expect.poll(() => switcherOrder()[0]).toBe("docs-site")
      await expectStaysAbsent(pin("docs-site"))
    })

    it("pins nothing when let go off the bar", async () => {
      arrange(["storefront"])
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      await workspaceSwitcher().click()
      const before = switcherOrder()
      expect(before).toContain("mobile-app")
      await dragOut("mobile-app", { x: 700, y: 400 })
      await expectStaysAbsent(pin("mobile-app"))
      expect(pinsBar().getByRole("button").elements()).toHaveLength(1)
      // Nor does it move in the list.
      await workspaceSwitcher().click()
      await expect.poll(switcherOrder).toEqual(before)
    })

    it("pins nothing when Escape cancels the drag on the bar", async () => {
      arrange(["storefront"])
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      await workspaceSwitcher().click()
      const before = switcherOrder()
      escapeOnceHandedOver("mobile-app")
      await dragOut("mobile-app")
      await expectStaysAbsent(pin("mobile-app"))
      expect(pinsBar().getByRole("button").elements()).toHaveLength(1)
      await workspaceSwitcher().click()
      await expect.poll(switcherOrder).toEqual(before)
    })
  })

  it("hides the pins that don't fit, and the dot covers them again", async () => {
    // Seven pins in a narrow window: the last, docs-site, has no room, so the dot shows
    // its question instead of leaving it out.
    arrange([
      "storefront",
      "api-service",
      "mobile-app",
      "design-system",
      "infra",
      "dotfiles",
      "docs-site",
    ])
    await page.viewport(600, 900)
    onTestFinished(() => page.viewport(1440, 900))
    await openWorkspace("/?demo=agents")
    await skipWelcome()
    await expect.element(pin("storefront")).toBeVisible()
    await expect.element(pin("docs-site")).not.toBeInTheDocument()
    await expect.element(workspaceSwitcher()).toHaveAttribute("data-project-status", "ask")
  })

  it("keeps the other pins where they are when switching", async () => {
    arrange(["storefront", "api-service", "docs-site", "mobile-app"])
    await openWorkspace("/?demo=agents")
    await skipWelcome()
    const xs = () =>
      pinsBar()
        .getByRole("button")
        .elements()
        .map((button) => Math.round(button.getBoundingClientRect().right * 100) / 100)
    await pin("storefront").click()
    await expect.element(pin("storefront")).toHaveAttribute("aria-current", "true")
    const before = xs()
    // Each pin in turn becomes current, and every pin keeps its width, so none moves.
    for (const name of ["api-service", "docs-site", "mobile-app", "storefront"]) {
      // eslint-disable-next-line no-await-in-loop -- Each pin is current in turn.
      await pin(name).click()
      // eslint-disable-next-line no-await-in-loop -- Each pin is current in turn.
      await expect.element(pin(name)).toHaveAttribute("aria-current", "true")
      expect(xs()).toEqual(before)
    }
  })

  it("keeps a moved pin shown: the last shown pin can't step into the hidden ones", async () => {
    arrange([
      "storefront",
      "api-service",
      "mobile-app",
      "design-system",
      "infra",
      "dotfiles",
      "docs-site",
    ])
    await page.viewport(600, 900)
    onTestFinished(() => page.viewport(1440, 900))
    await openWorkspace("/?demo=agents")
    await skipWelcome()
    const shownNames = () =>
      pinsBar()
        .getByRole("button")
        .elements()
        .filter((button) => !button.hasAttribute("inert"))
        .map((button) => button.textContent)
    const before = shownNames()
    expect(before.length).toBeGreaterThan(1)
    expect(before.length).toBeLessThan(7)
    const lastShown = before[before.length - 1]!.replace(/^\d+/, "")
    const lastPin = pin(lastShown)
    expect(lastPin.element().getAttribute("aria-keyshortcuts")).not.toContain("Alt+ArrowRight")
    lastPin.element().focus()
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}")
    expect(shownNames()).toEqual(before)
    await expect.element(lastPin).toHaveFocus()
  })
})
