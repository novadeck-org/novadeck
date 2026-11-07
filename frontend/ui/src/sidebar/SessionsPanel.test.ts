import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach } from "vitest"

import { describe, expect, it } from "../test"
import { SessionsPanel, type SessionGlance } from "./SessionsPanel"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const mark = (extra: Partial<SessionGlance>): SessionGlance => ({
  status: undefined,
  label: undefined,
  need: undefined,
  lines: [],
  ...extra,
})

const panel = () => {
  const view = render(
    createElement(SessionsPanel, {
      sessions: [
        {
          id: "a",
          name: "Release",
          visitedAt: null,
          terminalNames: ["One", "Two"],
          running: 1,
          mark: mark({
            status: "unblock",
            label: "Needs you",
            need: "1 needs you",
            lines: ["Needs you: @glint · Polish"],
          }),
        },
        { id: "b", name: "Quiet", visitedAt: null, terminalNames: [], running: 0 },
        {
          id: "c",
          name: "Spinning",
          visitedAt: null,
          terminalNames: ["x"],
          running: 1,
          mark: mark({ status: "running", label: "Working" }),
        },
      ],
      activeId: "a",
      onSelect: () => {},
      onFresh: () => {},
    }),
  )
  unmounts.push(view.unmount)
  return view.container
}
const row = (container: Element, id: string) =>
  container.querySelector(`[data-workspace-session="${id}"]`)!

describe("The Sessions panel's marks", () => {
  it("marks each session with its status, the open one too, and a quiet one with none", () => {
    const container = panel()
    expect(
      row(container, "a").querySelector("[data-project-status] > .project-status-mark"),
    ).not.toBeNull()
    expect(
      row(container, "a")
        .querySelector("[data-project-status]")!
        .getAttribute("data-project-status"),
    ).toBe("unblock")
    expect(row(container, "b").querySelector("[data-project-status]")).toBeNull()
    expect(
      row(container, "c")
        .querySelector("[data-project-status]")!
        .getAttribute("data-project-status"),
    ).toBe("running")
  })

  it("says what needs the person in the detail line, before what runs", () => {
    const detail = row(panel(), "a").querySelector(".sidebar-item-detail")!
    expect(detail.textContent).toBe("2 terminals1 needs you")
    expect(row(panel(), "b").querySelector(".sidebar-item-detail")!.textContent).toBe("0 terminals")
  })

  it("shows the running count only where nothing needs the person", () => {
    expect(row(panel(), "c").querySelector(".sidebar-item-detail")!.textContent).toBe(
      "1 terminal1 running",
    )
  })

  it("says the status first in the row's description, for a screen reader", () => {
    const description = (id: string) =>
      row(panel(), id).querySelector(".sidebar-item-select")!.getAttribute("aria-description")!
    expect(description("a")).toMatch(/^Needs you\. Open now\./)
    expect(description("b")).toMatch(/^Not opened yet\./)
    expect(
      row(panel(), "a").querySelector("[data-project-status]")!.getAttribute("aria-hidden"),
    ).toBe("true")
  })

  it("names those terminals in the row's description before the terminal list", () => {
    const description = row(panel(), "a")
      .querySelector(".sidebar-item-select")!
      .getAttribute("aria-description")!
    expect(description).toContain("Needs you: @glint · Polish. One, Two")
  })
})
