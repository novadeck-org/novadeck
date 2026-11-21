import type { AgentMode } from "@novadeck/core/port"
import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"

import { context, describe, expect, it } from "../test"
import { agentModeChoice, agentModeChoices } from "./agent-mode-choices"
import { AgentModeMap } from "./AgentModeMap"
import { AgentModePicker } from "./AgentModePicker"

const mapOf = (mode: AgentMode) =>
  createElement(AgentModeMap, { mode, label: agentModeChoice(mode).map })
const map = (within: HTMLElement): HTMLElement =>
  within.querySelector<HTMLElement>(".agent-mode-map")!
// The parts a mode shows, by what each says (its handle or mark).
const shownIn = (within: HTMLElement, mode: AgentMode): string[] =>
  [...within.querySelectorAll<HTMLElement>(".agent-mode-map-agent, .agent-mode-map-need")]
    .filter((part) => !part.dataset.in || part.dataset.in.split(" ").includes(mode))
    .map((part) => part.firstChild?.textContent || part.textContent || "")

describe("the agent mode map", () => {
  it("offers the modes in order, with only Swarm costing more", () => {
    expect(agentModeChoices.map((choice) => choice.label)).toEqual(["Solo", "Herd", "Swarm"])
    expect(agentModeChoices.filter((choice) => choice.cost).map((choice) => choice.mode)).toEqual([
      "swarm",
    ])
  })

  it("reads each mode's map aloud in its place", () => {
    const page = render(mapOf("solo"))

    expect(map(page.container).getAttribute("role")).toBe("img")
    expect(map(page.container).getAttribute("aria-label")).toBe(agentModeChoice("solo").map)
  })

  context("as Preferences opens", () => {
    it("stands still", () => {
      const page = render(mapOf("herd"))

      expect(map(page.container).dataset.mode).toBe("herd")
      expect(map(page.container).hasAttribute("data-play")).toBe(false)
    })
  })

  context("once the person picks a mode", () => {
    it("plays each pick afresh, back to the first mode too", () => {
      const page = render(mapOf("herd"))

      page.rerender(mapOf("swarm"))
      expect(map(page.container).dataset.mode).toBe("swarm")
      expect(map(page.container).dataset.play).toBe("odd")

      // A new parity names new keyframes, so parts Herd and Swarm share draw in again.
      page.rerender(mapOf("herd"))
      expect(map(page.container).dataset.play).toBe("even")
      page.rerender(mapOf("solo"))
      expect(map(page.container).dataset.play).toBe("odd")
    })
  })

  it("runs Herd's message over the port's name, where it shows", () => {
    const page = render(mapOf("herd"))
    const pulse = page.container.querySelector<HTMLElement>(".agent-mode-map-pulse")!

    expect(pulse.dataset.in).toBe("herd")
    expect(pulse.parentElement?.querySelector(".agent-mode-map-port")).not.toBeNull()
    expect(pulse.closest("svg")).toBeNull()
  })

  it("asks you only in Solo, and draws Swarm's team only in Swarm", () => {
    const page = render(mapOf("solo"))
    const asks = (mode: AgentMode) => shownIn(page.container, mode).filter((part) => part === "?")

    expect(asks("solo")).toHaveLength(2)
    expect(asks("herd")).toHaveLength(0)
    expect(shownIn(page.container, "swarm").join(" ")).toContain("@wren")
    expect(shownIn(page.container, "herd").join(" ")).not.toContain("@wren")
  })
})

describe("the Agents work as picker", () => {
  const picker = (mode: AgentMode) => createElement(AgentModePicker, { mode, onChange: () => {} })
  const note = "Agents already running follow it fully from their next session."

  it("says when running agents follow a change, once there is one", () => {
    const page = render(picker("herd"))
    expect(page.container.textContent).not.toContain(note)

    page.rerender(picker("solo"))
    expect(page.container.textContent).toContain(note)

    page.rerender(picker("herd"))
    expect(page.container.textContent).not.toContain(note)
  })
})
