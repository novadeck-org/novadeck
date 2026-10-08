import { act, createElement, useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Project } from "../model/types"
import { render, type Rendered } from "../test/render"
import { moveProject, noArrangement, togglePin } from "./project-arrangement"
import { WorkspaceSwitcher } from "./WorkspaceSwitcher"

// dnd-kit watches sizes as soon as it loads, which jsdom can't.
vi.hoisted(() => {
  Object.assign(globalThis, {
    ResizeObserver: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  })
})

const projects: Project[] = ["a-one", "b-two", "c-three", "d-four"].map((name) => ({
  id: name,
  name,
  directory: `~/projects/${name}`,
}))

const Harness = (): React.JSX.Element => {
  const [arrangement, setArrangement] = useState(noArrangement)
  return createElement(WorkspaceSwitcher, {
    projects,
    current: projects[0]!,
    statuses: {},
    arrangement,
    dotIgnores: [],
    onSelect: () => {},
    onMove: (id, index) => setArrangement((before) => moveProject(projects, before, id, index)),
    onStep: () => {},
    onTogglePin: (id) => setArrangement((before) => togglePin(projects, before, id)),
  })
}

let rendered: Rendered | undefined
afterEach(() => {
  rendered?.unmount()
  rendered = undefined
})

const button = (label: string): HTMLButtonElement =>
  document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!

describe("WorkspaceSwitcher pinning", () => {
  it("lets three projects be pinned and disables pinning a fourth", async () => {
    rendered = render(createElement(Harness))
    await act(async () => button("Switch workspace").click())

    await act(async () => button("Pin a-one").click())
    await act(async () => button("Pin b-two").click())
    await act(async () => button("Pin c-three").click())

    expect(button("Pin d-four").disabled).toBe(true)
    expect(button("Unpin c-three").disabled).toBe(false)
    expect(document.body.querySelectorAll("hr")).toHaveLength(1)
  })
})
