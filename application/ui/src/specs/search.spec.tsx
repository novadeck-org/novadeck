import { describe as context, describe, expect, it } from "vitest"
import { page } from "vitest/browser"

import {
  expectSearchReady,
  findDialog,
  pressShortcut,
  searchField,
  searchResult,
  shortcut,
  viewRegion,
} from "./support/keyboard"
import {
  chooseView,
  commandInput,
  expectSelected,
  expectStaysAbsent,
  openWorkspace,
  press,
  terminal,
  terminalTab,
  view,
} from "./support/workspace"

describe("finding a terminal", () => {
  for (const { label, keys } of [shortcut.find(), { label: "/", keys: "/" }]) {
    context(`when pressing ${label}`, () => {
      it("opens search with the field focused and every terminal listed", async () => {
        await openWorkspace()

        await press(keys)

        await expect.element(findDialog()).toBeVisible()
        await expect.element(searchField()).toHaveFocus()
        await expect.element(findDialog().getByRole("option")).toHaveLength(6)
        await expect.element(searchResult("Checkout implementation")).toBeVisible()
        await expect.element(searchResult("Build")).toBeVisible()
      })
    })
  }

  context("when clicking the Find a terminal button", () => {
    it("opens search", async () => {
      await openWorkspace()

      await page.getByRole("button", { name: "Find a terminal" }).click()

      await expect.element(findDialog()).toBeVisible()
    })
  })

  context("when pressing Ctrl+K alone in a terminal input", () => {
    it(`leaves the key to the terminal and still opens search with ${shortcut.find().label}`, async () => {
      await openWorkspace()
      await commandInput("Checkout implementation").click()
      await expect.element(commandInput("Checkout implementation")).toHaveFocus()

      await press("{Control>}k{/Control}")
      await expectStaysAbsent(findDialog())
      await expect.element(commandInput("Checkout implementation")).toHaveFocus()

      await pressShortcut("find")
      await expect.element(findDialog()).toBeVisible()
    })
  })

  context("when typing a query", () => {
    it("lists only matching terminals", async () => {
      await openWorkspace()
      await press("/")
      await expectSearchReady()

      await searchField().fill("checkout")

      await expect.element(searchResult("Checkout implementation")).toBeVisible()
      await expect.element(searchResult("Checkout review")).toBeVisible()
      await expect.element(searchResult("Dev server")).not.toBeInTheDocument()
      await expect.element(searchResult("Build")).not.toBeInTheDocument()
    })

    it("matches the working directory too", async () => {
      await openWorkspace()
      await press("/")
      await expectSearchReady()

      await searchField().fill("storefront/runtime")

      await expect.element(searchResult("Runtime")).toBeVisible()
      await expect.element(findDialog().getByRole("option")).toHaveLength(1)
    })

    it("says so when nothing matches", async () => {
      await openWorkspace()
      await press("/")
      await expectSearchReady()

      await searchField().fill("nothing here")

      await expect
        .element(findDialog().getByText("No terminals match “nothing here”."))
        .toBeVisible()
      await expect.element(findDialog().getByRole("option")).toHaveLength(0)
    })
  })

  context("when clicking a result", () => {
    it("closes search and shows that terminal in Focus", async () => {
      await openWorkspace()
      await press("/")
      await expectSearchReady()
      await expect.element(findDialog().getByText("Open in Focus")).toBeVisible()

      await searchResult("Runtime").click()

      await expect.element(findDialog()).not.toBeInTheDocument()
      await expect.element(terminal("Runtime")).toBeVisible()
      await expect.element(terminal("Checkout implementation")).not.toBeInTheDocument()
      await expectSelected("Runtime")
    })
  })

  context("when choosing a result with the keyboard", () => {
    it("opens the highlighted result on Enter", async () => {
      await openWorkspace()
      await press("/")
      await expectSearchReady()
      await searchField().fill("storefront/ui")
      await expect.element(findDialog().getByRole("option")).toHaveLength(2)

      await press("{ArrowDown}{Enter}")

      await expect.element(findDialog()).not.toBeInTheDocument()
      await expect.element(terminal("Tests")).toBeVisible()
      await expectSelected("Tests")
    })

    it("opens the last result after End", async () => {
      await openWorkspace()
      await press("/")
      await expectSearchReady()

      await press("{End}{Enter}")

      await expect.element(findDialog()).not.toBeInTheDocument()
      await expectSelected("Build")
    })
  })

  for (const name of ["Grid", "Canvas"] as const) {
    context(`when searching from ${name}`, () => {
      it(`opens the result in ${name}`, async () => {
        await openWorkspace()
        await chooseView(name)
        await page.getByRole("button", { name: "Find a terminal" }).click()
        await expect.element(findDialog().getByText(`Open in ${name}`)).toBeVisible()

        await searchResult("Build").click()

        await expect.element(findDialog()).not.toBeInTheDocument()
        await expect.element(view(name)).toBeChecked()
        await expectSelected("Build")
      })
    })
  }

  context("when pressing Escape", () => {
    it("closes search and keeps the current terminal", async () => {
      await openWorkspace()
      await terminalTab("Dev server").click()
      await press("/")
      await expectSearchReady()
      await expect.element(findDialog()).toBeVisible()

      await press("{Escape}")

      await expect.element(findDialog()).not.toBeInTheDocument()
      await expectSelected("Dev server")
      await expect.element(terminal("Dev server")).toBeVisible()
    })
  })

  context("when clicking Close search", () => {
    it("closes search", async () => {
      await openWorkspace()
      await press("/")
      await expectSearchReady()

      await findDialog().getByRole("button", { name: "Close search" }).click()

      await expect.element(findDialog()).not.toBeInTheDocument()
    })
  })

  context("when pressing arrows while search is open", () => {
    it("keeps the workspace view and selection", async () => {
      await openWorkspace()
      await press("/")
      await expectSearchReady()

      await press("{ArrowRight}{ArrowDown}")
      await expect.element(findDialog()).toBeVisible()
      await press("{Escape}")

      await expect.element(findDialog()).not.toBeInTheDocument()
      await expectStaysAbsent(viewRegion("grid"))
      await expectStaysAbsent(terminal("Dev server"))
      await expect.element(view("Focus")).toBeChecked()
      await expectSelected("Checkout implementation")
    })
  })
})
