import { createElement } from "react"
import { afterEach } from "vitest"

import type { TerminalMetadata } from "../../model/types"
import { describe, expect, it } from "../../test"
import { render, type Rendered } from "../../test/render"
import { createMockTerminal } from "./samples"
import { TerminalOutput } from "./TerminalOutput"

const mounted: Rendered[] = []
afterEach(() => mounted.splice(0).forEach((view) => view.unmount()))

const claude: TerminalMetadata = {
  ...createMockTerminal({ projectId: "p", workspaceSessionId: "s" }, 1, "~/p"),
  id: "01",
  process: "claude",
  state: "running",
  agent: { working: true },
}
const show = (planned: boolean) =>
  createElement(TerminalOutput, { terminal: claude, projectName: "p", planned })

// Whether the agent opened planning is the engine's to keep (see DemoTerminal.test.ts).
describe("terminal output", () => {
  it("opens a planning agent with its plan request", () => {
    const view = render(show(true))
    mounted.push(view)
    expect(view.container.textContent).toContain("Plan a compact order summary")
  })

  it("opens an agent that was not planning with its task", () => {
    const view = render(show(false))
    mounted.push(view)
    expect(view.container.textContent).toContain("Add a compact order summary")
    expect(view.container.textContent).not.toContain("Plan a compact order summary")
  })
})
