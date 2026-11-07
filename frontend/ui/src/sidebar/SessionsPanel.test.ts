import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach } from "vitest"

import { describe, expect, it } from "../test"
import type { SessionMark } from "./session-marks"
import { SessionsPanel } from "./SessionsPanel"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const mark = (extra: Partial<SessionMark>): SessionMark => ({
  status: undefined,
  needsYou: 0,
  asks: 0,
  failed: 0,
  done: 0,
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
          mark: mark({ status: "unblock", needsYou: 1, lines: ["Needs you: @glint · Polish"] }),
        },
        { id: "b", name: "Quiet", visitedAt: null, terminalNames: [], running: 0 },
        {
          id: "c",
          name: "Spinning",
          visitedAt: null,
          terminalNames: ["x"],
          running: 1,
          mark: mark({ status: "running" }),
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
    expect(detail.textContent).toBe("2 terminals1 needs you1 running")
    expect(row(panel(), "b").querySelector(".sidebar-item-detail")!.textContent).toBe("0 terminals")
  })

  it("names those terminals in the row's description before the terminal list", () => {
    const description = row(panel(), "a")
      .querySelector(".sidebar-item-select")!
      .getAttribute("aria-description")!
    expect(description).toContain("Needs you: @glint · Polish. One, Two")
  })
})
