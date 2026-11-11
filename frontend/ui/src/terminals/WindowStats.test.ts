import type { AgentStats } from "@novadeck/core/agents/stats"
import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { vi } from "vitest"

import { describe, expect, it } from "../test"
import { WindowStats } from "./WindowStats"

const stats: AgentStats = { model: "Opus 5.5", effort: null, context: null } as AgentStats

describe("the window's stats", () => {
  it("tell the host how far they reach, for the chat's held prompt to keep clear of", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(120)
    const { container: host, unmount } = render(createElement(WindowStats, { stats }))
    expect(host.style.getPropertyValue("--chat-stats-clear")).toBe("136px")
    unmount()
    expect(host.style.getPropertyValue("--chat-stats-clear")).toBe("")
  })
})
