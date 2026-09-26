import { describe as context, describe, expect, it } from "vitest"
import { page, userEvent, type Locator } from "vitest/browser"

import {
  anyRenameField,
  headerAction,
  headerName,
  headerRenameField,
  hiddenTerminalTab,
  newTerminalButton,
  renderedOpacity,
  tabName,
  sidebarRenameField,
  tabAction,
  visibilityToggle,
} from "./support/terminals"
import {
  chooseView,
  commandInput,
  expectSelected,
  expectStaysAbsent,
  openWorkspace,
  press,
  sidebar,
  terminal,
  terminalTab,
  terminalTabNames,
  visibleTerminalCounts,
  view,
} from "./support/workspace"

const views = ["Focus", "Grid", "Canvas"] as const

/** A terminal's offset and size relative to a neighbour, rounded to whole pixels. */
const placeBeside = (subject: Locator, neighbour: Locator): number[] => {
  const box = subject.element().getBoundingClientRect()
  const other = neighbour.element().getBoundingClientRect()
  return [box.left - other.left, box.top - other.top, box.width, box.height].map(Math.round)
}

/**
 * Drags a tab by pointer onto the top quarter of another tab, clearly past the
 * destination's leading edge. Interpolated moves let the list follow the drag.
 */
const dragTabOnto = async (source: string, destination: string): Promise<void> => {
  const target = terminalTab(destination)
  const { width, height } = target.element().getBoundingClientRect()
  await userEvent.dragAndDrop(terminalTab(source), target, {
    targetPosition: { x: width / 2, y: height / 4 },
    steps: 20,
  })
}

describe("creating terminals", () => {
  for (const name of views) {
    for (const trigger of ["New terminal button", "T key"] as const) {
      context(`when using the ${trigger} in ${name}`, () => {
        it("adds a selected terminal that is shown right away and counted in the footer", async () => {
          await openWorkspace()
          await chooseView(name)
          await expect.poll(visibleTerminalCounts).toEqual(["6 terminals"])

          if (trigger === "T key") {
            // The view choice keeps keyboard focus in its radio input, which workspace keys skip.
            await terminalTab("Dev server").click()
            await press("t")
          } else await newTerminalButton().click()

          await expect.element(sidebarRenameField("Terminal 07")).toHaveFocus()
          await press("{Enter}")
          await expectSelected("Terminal 07")
          await expect.element(terminal("Terminal 07")).toBeInViewport()
          await expect.element(commandInput("Terminal 07")).toHaveValue("")
          await expect.poll(visibleTerminalCounts).toEqual(["7 terminals"])
        })
      })
    }
  }

  context("when the new terminal's name editor opens", () => {
    it("selects the whole name so typing replaces it", async () => {
      await openWorkspace()
      await newTerminalButton().click()
      await expect.element(sidebarRenameField("Terminal 07")).toHaveFocus()

      await press("My shell{Enter}")

      await expect.element(terminalTab("My shell")).toBeVisible()
      await expect.element(headerName("My shell")).toBeVisible()
    })

    it("keeps the original name when Escape is pressed", async () => {
      await openWorkspace()
      await newTerminalButton().click()
      await expect.element(sidebarRenameField("Terminal 07")).toHaveFocus()

      await press("Discarded{Escape}")

      await expect.element(anyRenameField()).not.toBeInTheDocument()
      await expectStaysAbsent(terminalTab("Discarded"))
      await expectSelected("Terminal 07")
      await expect.element(headerName("Terminal 07")).toBeVisible()
    })

    it("saves the typed name when clicking away", async () => {
      await openWorkspace()
      await chooseView("Grid")
      await newTerminalButton().click()
      await expect.element(sidebarRenameField("Terminal 07")).toHaveFocus()

      await press("Scratch")
      await sidebar()
        .getByRole("heading", { name: /^Terminals/ })
        .click()

      await expect.element(anyRenameField()).not.toBeInTheDocument()
      await expect.element(terminalTab("Scratch")).toBeVisible()
      await expect.element(terminal("Scratch")).toBeVisible()
    })
  })

  context("when the sidebar is hidden and the T key is pressed", () => {
    it("opens the Terminals sidebar to name the new terminal", async () => {
      await openWorkspace()
      await chooseView("Grid")
      await sidebar().getByRole("button", { name: "Hide terminals" }).click()
      await expect.element(sidebar()).not.toBeInTheDocument()

      await press("t")

      await expect.element(sidebarRenameField("Terminal 07")).toHaveFocus()
      await expect.element(terminal("Terminal 07")).toBeVisible()
    })
  })

  context("when creating a terminal in Zen, where the sidebar is not shown", () => {
    it("names the new terminal in its header", async () => {
      await openWorkspace()
      await chooseView("Grid")
      await page.getByRole("button", { name: "Enter Zen mode" }).click()
      await expect.element(sidebar()).not.toBeInTheDocument()

      await page.getByRole("button", { name: "New terminal" }).click()

      await expect.element(headerRenameField("Terminal 07")).toHaveFocus()
      await press("Zen shell{Enter}")
      await expect.element(headerName("Zen shell")).toBeVisible()
    })
  })
})

describe("renaming terminals", () => {
  for (const name of views) {
    context(`when double-clicking the header name in ${name}`, () => {
      it("renames the terminal in place and stays in the view", async () => {
        await openWorkspace()
        await chooseView(name)
        await terminalTab("Dev server").click()

        await headerName("Dev server").dblClick()

        await expect.element(headerRenameField("Dev server")).toHaveFocus()
        // Typed key by key: every keystroke must land, including while the view re-renders.
        await press("My server typed key by key{Enter}")
        await expect.element(headerName("My server typed key by key")).toBeVisible()
        await expect.element(terminalTab("My server typed key by key")).toBeVisible()
        await expect.element(view(name)).toBeChecked()
      })

      it("keeps the original name when Escape is pressed", async () => {
        await openWorkspace()
        await chooseView(name)
        await terminalTab("Dev server").click()

        await headerName("Dev server").dblClick()
        await expect.element(headerRenameField("Dev server")).toHaveFocus()
        await press("Discarded{Escape}")

        await expect.element(anyRenameField()).not.toBeInTheDocument()
        await expectStaysAbsent(terminalTab("Discarded"))
        await expect.element(headerName("Dev server")).toBeVisible()
        await expect.element(terminalTab("Dev server")).toBeVisible()
      })
    })
  }

  context("when double-clicking a tab's name in the sidebar", () => {
    it("selects the terminal without renaming it", async () => {
      await openWorkspace()

      await terminalTab("Dev server").dblClick()

      await expectSelected("Dev server")
      await expectStaysAbsent(anyRenameField())
      await expect.element(headerName("Dev server")).toBeVisible()
    })
  })

  context("when using the tab's Rename button", () => {
    it("edits the name in the sidebar and trims the saved name", async () => {
      await openWorkspace()
      await chooseView("Grid")

      await tabAction("Rename Dev server").click()
      await expect.element(sidebarRenameField("Dev server")).toHaveFocus()
      await press("  Local shell  ")
      await tabAction("Save name for Dev server").click()

      await expect.element(terminalTab("Local shell")).toBeVisible()
      await expect.element(headerName("Local shell")).toBeVisible()
    })

    it("discards the draft with the Cancel button", async () => {
      await openWorkspace()

      await tabAction("Rename Dev server").click()
      await press("Discarded")
      await tabAction("Cancel renaming Dev server").click()

      await expect.element(anyRenameField()).not.toBeInTheDocument()
      await expectStaysAbsent(terminalTab("Discarded"))
      await expect.element(terminalTab("Dev server")).toBeVisible()
      await expect.element(tabAction("Close Dev server")).toBeVisible()
    })
  })

  context("when pressing F2", () => {
    it("renames the active terminal in the sidebar", async () => {
      await openWorkspace()
      await chooseView("Grid")
      await terminalTab("Tests").click()

      await press("{F2}")

      await expect.element(sidebarRenameField("Tests")).toHaveFocus()
      await press("Unit tests{Enter}")
      await expect.element(terminalTab("Unit tests")).toBeVisible()
    })

    it("renames the active terminal in its header when the sidebar is hidden", async () => {
      await openWorkspace()
      await chooseView("Grid")
      await terminalTab("Tests").click()
      await sidebar().getByRole("button", { name: "Hide terminals" }).click()
      await expect.element(sidebar()).not.toBeInTheDocument()

      await press("{F2}")

      await expect.element(headerRenameField("Tests")).toHaveFocus()
      await press("Unit tests{Enter}")
      await expect.element(headerName("Unit tests")).toBeVisible()
    })
  })

  context("when the name is visible in both the header and the sidebar", () => {
    it("shows the same draft in both fields and keeps editing when moving between them", async () => {
      await openWorkspace()
      await chooseView("Grid")
      await tabAction("Rename Dev server").click()
      await expect.element(sidebarRenameField("Dev server")).toHaveFocus()

      await press("Shared")
      await expect.element(headerRenameField("Dev server")).toHaveValue("Shared")

      await headerRenameField("Dev server").click()
      await press("{End} draft")
      await expect.element(sidebarRenameField("Dev server")).toHaveValue("Shared draft")
      await expect.element(headerRenameField("Dev server")).toHaveValue("Shared draft")
    })

    it("ends the edit in both places when Escape is pressed in either", async () => {
      await openWorkspace()
      await chooseView("Grid")
      await tabAction("Rename Dev server").click()
      await press("Discarded")
      await headerRenameField("Dev server").click()

      await press("{Escape}")

      await expect.element(anyRenameField()).not.toBeInTheDocument()
      await expectStaysAbsent(terminalTab("Discarded"))
      await expect.element(headerName("Dev server")).toBeVisible()
      await expect.element(terminalTab("Dev server")).toBeVisible()
    })

    it("saves a draft started in the header from the sidebar", async () => {
      await openWorkspace()
      await chooseView("Canvas")
      await headerName("Dev server").dblClick()
      await expect.element(headerRenameField("Dev server")).toHaveFocus()
      await press("Shared shell")

      await sidebarRenameField("Dev server").click()
      await press("{Enter}")

      await expect.element(anyRenameField()).not.toBeInTheDocument()
      await expect.element(terminalTab("Shared shell")).toBeVisible()
      await expect.element(headerName("Shared shell")).toBeVisible()
    })
  })
})

describe("closing terminals", () => {
  context("when clicking Close in the terminal header", () => {
    it("removes the terminal, selects its neighbour, and updates the footer", async () => {
      await openWorkspace()

      await headerAction("Checkout implementation", "Close Checkout implementation").click()

      await expect.element(terminalTab("Checkout implementation")).not.toBeInTheDocument()
      await expectSelected("Dev server")
      await expect.element(terminal("Dev server")).toBeVisible()
      await expect.poll(visibleTerminalCounts).toEqual(["5 terminals"])
    })
  })

  context("when clicking Close on a sidebar tab", () => {
    it("removes that terminal from the list and the view", async () => {
      await openWorkspace()
      await chooseView("Grid")
      await expect.element(terminal("Tests")).toBeVisible()

      await tabAction("Close Tests").click()

      await expect.element(terminalTab("Tests")).not.toBeInTheDocument()
      await expect.element(terminal("Tests")).not.toBeInTheDocument()
      await expectSelected("Checkout implementation")
      await expect.poll(visibleTerminalCounts).toEqual(["5 terminals"])
    })
  })

  context("when every terminal is closed", () => {
    it("shows an empty workspace that can start again", async () => {
      await openWorkspace()
      for (const name of terminalTabNames()) {
        // oxlint-disable-next-line no-await-in-loop -- Each close changes the list.
        await tabAction(`Close ${name}`).click()
      }

      await expect.element(page.getByRole("heading", { name: "No terminals open" })).toBeVisible()
      await expect.poll(visibleTerminalCounts).toEqual(["0 terminals"])

      await newTerminalButton().click()
      await press("{Enter}")
      await expect.element(terminal("Terminal 07")).toBeVisible()
    })
  })

  context("when a single terminal is left", () => {
    it("counts it in the singular", async () => {
      await openWorkspace()
      for (const name of terminalTabNames().slice(1)) {
        // oxlint-disable-next-line no-await-in-loop -- Each close changes the list.
        await tabAction(`Close ${name}`).click()
      }

      await expect.poll(visibleTerminalCounts).toEqual(["1 terminal"])
    })
  })

  for (const name of views) {
    context(`when pressing Delete in ${name}`, () => {
      it("closes the active terminal", async () => {
        await openWorkspace()
        await chooseView(name)
        await terminalTab("Dev server").click()

        await press("{Delete}")

        await expect.element(terminalTab("Dev server")).not.toBeInTheDocument()
        await expect.element(terminal("Dev server")).not.toBeInTheDocument()
        await expect.poll(visibleTerminalCounts).toEqual(["5 terminals"])
      })

      it("leaves the terminal open when Delete is pressed in its command input", async () => {
        await openWorkspace()
        await chooseView(name)
        await terminalTab("Dev server").click()
        await commandInput("Dev server").fill("npm run")
        // Home does not move the input caret to its start on macOS.
        await press("{ArrowLeft}".repeat("npm run".length))

        await press("{Delete}")

        await expect.element(commandInput("Dev server")).toHaveValue("pm run")
        await expectStaysAbsent(page.getByText("5 terminals", { exact: true }))
        await expectSelected("Dev server")
        await expect.poll(visibleTerminalCounts).toEqual(["6 terminals"])
      })
    })
  }
})

describe("hiding terminals from Grid and Canvas", () => {
  context("when clicking the eye on a tab", () => {
    it("keeps the tab in the list with a faded label and keeps the current selection", async () => {
      await openWorkspace()
      await chooseView("Grid")

      await visibilityToggle("Dev server", "Hide").click()

      await expect.element(hiddenTerminalTab("Dev server")).toBeVisible()
      await expect.element(visibilityToggle("Dev server", "Show")).toBeVisible()
      await expect.poll(() => renderedOpacity(tabName("Dev server"))).toBeLessThan(0.75)
      expect(renderedOpacity(tabName("Tests"))).toBeCloseTo(1)
      await expectSelected("Checkout implementation")
      // Selecting a hidden terminal would bring it back into Grid, so it must stay out.
      await expect.element(terminal("Dev server")).not.toBeInTheDocument()
      await expectStaysAbsent(terminal("Dev server"))
    })

    for (const name of ["Grid", "Canvas"] as const) {
      it(`removes the terminal from ${name}`, async () => {
        await openWorkspace()
        await chooseView(name)
        await expect.element(terminal("Dev server")).toBeInTheDocument()

        await visibilityToggle("Dev server", "Hide").click()

        await expect.element(terminal("Dev server")).not.toBeInTheDocument()
        await expect.element(terminal("Tests")).toBeInTheDocument()
      })
    }

    it("still shows the terminal in Focus", async () => {
      await openWorkspace()
      await visibilityToggle("Dev server", "Hide").click()

      await hiddenTerminalTab("Dev server").click()

      await expect.element(terminal("Dev server")).toBeVisible()
    })
  })

  for (const name of ["Grid", "Canvas"] as const) {
    context(`when a hidden terminal is selected in ${name}`, () => {
      it("shows it at half the opacity of a selected visible terminal", async () => {
        await openWorkspace()
        await chooseView(name)
        await visibilityToggle("Dev server", "Hide").click()
        await expect.element(terminal("Dev server")).not.toBeInTheDocument()

        await hiddenTerminalTab("Dev server").click()

        await expectSelected("Dev server (hidden)")
        await expect.element(terminal("Dev server")).toBeVisible()
        await expect.poll(() => renderedOpacity(headerName("Dev server"))).toBeCloseTo(0.5, 1)
        await expect.element(visibilityToggle("Dev server", "Show")).toBeVisible()

        await terminalTab("Tests").click()

        await expectSelected("Tests")
        await expect.poll(() => renderedOpacity(headerName("Tests"))).toBeCloseTo(1, 1)
      })

      it("removes it again once another terminal is selected", async () => {
        await openWorkspace()
        await chooseView(name)
        await visibilityToggle("Dev server", "Hide").click()
        await hiddenTerminalTab("Dev server").click()
        await expect.element(terminal("Dev server")).toBeVisible()

        await terminalTab("Tests").click()

        await expect.element(terminal("Dev server")).not.toBeInTheDocument()
        await expect.element(hiddenTerminalTab("Dev server")).toBeVisible()
      })

      it("keeps its content", async () => {
        await openWorkspace()
        await chooseView(name)
        await commandInput("Dev server").fill("unfinished command")
        await terminalTab("Tests").click()
        await visibilityToggle("Dev server", "Hide").click()
        await expect.element(terminal("Dev server")).not.toBeInTheDocument()

        await hiddenTerminalTab("Dev server").click()

        await expect.element(commandInput("Dev server")).toHaveValue("unfinished command")
      })
    })
  }

  for (const name of ["Grid", "Canvas"] as const) {
    context(`when a hidden terminal is shown again in ${name}`, () => {
      it("returns to the same place and size beside its neighbours", async () => {
        await openWorkspace()
        await chooseView(name)
        const before = placeBeside(terminal("Dev server"), terminal("Checkout implementation"))
        await visibilityToggle("Dev server", "Hide").click()
        await expect.element(terminal("Dev server")).not.toBeInTheDocument()

        await visibilityToggle("Dev server", "Show").click()

        await expect.element(terminal("Dev server")).toBeVisible()
        await expect
          .poll(() => placeBeside(terminal("Dev server"), terminal("Checkout implementation")))
          .toEqual(before)
      })
    })
  }

  context("when clicking the eye on a hidden terminal while it is selected", () => {
    it("shows it at full opacity and keeps it in Grid after selecting another terminal", async () => {
      await openWorkspace()
      await chooseView("Grid")
      await visibilityToggle("Dev server", "Hide").click()
      await hiddenTerminalTab("Dev server").click()
      await expectSelected("Dev server (hidden)")
      await expect.poll(() => renderedOpacity(headerName("Dev server"))).toBeCloseTo(0.5, 1)

      await visibilityToggle("Dev server", "Show").click()

      await expectSelected("Dev server")
      await expect.poll(() => renderedOpacity(headerName("Dev server"))).toBeCloseTo(1, 1)
      await terminalTab("Tests").click()
      await expect.element(terminal("Dev server")).toBeVisible()
      await expect.element(terminalTab("Dev server")).toBeVisible()
    })
  })
})

describe("minimizing Grid terminals", () => {
  context("when clicking Minimize in the header", () => {
    it("folds the terminal and offers Restore", async () => {
      await openWorkspace()
      await chooseView("Grid")
      const minimize = headerAction("Dev server", "Minimize Dev server")
      await expect.element(minimize).toHaveAttribute("aria-expanded", "true")

      await minimize.click()

      const restore = headerAction("Dev server", "Restore Dev server")
      await expect.element(restore).toHaveAttribute("aria-expanded", "false")
      await expect.element(commandInput("Dev server")).not.toBeInTheDocument()
      await expect.element(headerName("Dev server")).toBeVisible()
    })
  })

  context("when clicking Restore", () => {
    it("unfolds the terminal with its draft intact", async () => {
      await openWorkspace()
      await chooseView("Grid")
      await commandInput("Dev server").fill("unfinished command")
      await headerAction("Dev server", "Minimize Dev server").click()
      await expect.element(commandInput("Dev server")).not.toBeInTheDocument()

      await headerAction("Dev server", "Restore Dev server").click()

      await expect
        .element(headerAction("Dev server", "Minimize Dev server"))
        .toHaveAttribute("aria-expanded", "true")
      await expect.element(commandInput("Dev server")).toHaveValue("unfinished command")
    })
  })

  context("when leaving Grid and coming back", () => {
    it("keeps the terminal minimized", async () => {
      await openWorkspace()
      await chooseView("Grid")
      await headerAction("Dev server", "Minimize Dev server").click()
      await expect.element(headerAction("Dev server", "Restore Dev server")).toBeVisible()

      await chooseView("Focus")
      await chooseView("Grid")

      await expect
        .element(headerAction("Dev server", "Restore Dev server"))
        .toHaveAttribute("aria-expanded", "false")
    })
  })
})

describe("reordering terminal tabs", () => {
  context("when dragging a tab onto another", () => {
    it("moves it to that position", async () => {
      await openWorkspace()
      expect(terminalTabNames().slice(0, 3)).toEqual([
        "Checkout implementation",
        "Dev server",
        "Tests",
      ])

      await dragTabOnto("Tests", "Checkout implementation")

      await expect
        .poll(() => terminalTabNames().slice(0, 3))
        .toEqual(["Tests", "Checkout implementation", "Dev server"])
    })

    it("uses the new order when moving through terminals with Down", async () => {
      await openWorkspace()
      await dragTabOnto("Tests", "Checkout implementation")
      await expect.poll(() => terminalTabNames()[0]).toBe("Tests")
      await terminalTab("Tests").click()
      await expectSelected("Tests")

      await press("{ArrowDown}")

      await expectSelected("Checkout implementation")
    })
  })
})
