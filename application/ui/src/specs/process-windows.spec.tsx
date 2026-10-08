import { describe, expect, it } from "vitest"

import { headerAction, headerName } from "./support/terminals"
import { chooseView, commandInput, openWorkspace, terminal, terminalTab } from "./support/workspace"

const agents = [
  { name: "Checkout implementation", program: "claude" },
  { name: "Checkout review", program: "codex" },
] as const

describe("process windows", () => {
  it.each(agents)(
    "presents $program in its window with input and controls in every layout",
    async ({ name, program }) => {
      await openWorkspace("/projects/storefront/sessions/initial/grid?demo=agents")

      await expect.element(terminal(name)).toHaveAttribute("data-process-window", program)
      await expect.element(headerName(name)).toBeVisible()
      await expect.element(headerAction(name, `Close ${name}`)).toBeVisible()
      await expect.element(commandInput(name)).toBeVisible()
      await commandInput(name).fill(`Draft for ${program}`)
      await expect.element(terminal("Dev server")).not.toHaveAttribute("data-process-window")

      await chooseView("Canvas")
      await terminalTab(name).click()
      await expect.element(terminal(name)).toHaveAttribute("data-process-window", program)
      await expect.element(commandInput(name)).toHaveValue(`Draft for ${program}`)
      await expect.element(commandInput(name)).toBeVisible()

      await chooseView("Focus")
      await expect.element(terminal(name)).toHaveAttribute("data-process-window", program)
      await expect.element(headerName(name)).toBeVisible()
      await expect.element(commandInput(name)).toHaveValue(`Draft for ${program}`)
      await expect.element(headerAction(name, "Open in Canvas")).toBeVisible()
    },
  )
})
