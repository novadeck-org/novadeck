import type { Feedback } from "@novadeck/core/feedback"
import type { Backend } from "@novadeck/core/port"
import { terminalFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { vi } from "vitest"

import { describe, expect, it } from "../test"

const services: { backend: Partial<Backend> } = { backend: {} }

vi.mock("./controller/context", () => ({
  useWorkspaceServices: () => services,
  useWorkspaceState: () => ({ projectId: "p", workspaceSessionId: "s" }),
}))

const { useAskFeedback } = await import("./ask-feedback")

const agent = {
  ...terminalFixture(4, "~/p"),
  handle: "moth",
  process: "claude",
  state: "running" as const,
}

const offered = (feedback: Feedback | undefined): boolean => {
  services.backend = feedback ? { feedback } : {}
  const result: unknown[] = []
  const Probe = (): null => {
    result.push(useAskFeedback(agent as never))
    return null
  }
  render(createElement(Probe))
  return result.at(-1) !== undefined
}

const base: Feedback = {
  about: () => Promise.resolve({ version: "1.0.0", os: "Linux x64" }),
  send: () => Promise.resolve(),
}

describe("the window menu's feedback item", () => {
  it("is offered where the backend's feedback can ask an agent", () => {
    expect(offered({ ...base, ask: () => Promise.resolve() })).toBe(true)
  })

  it("is left out when the feedback has no ask, or the backend no feedback", () => {
    expect(offered(base)).toBe(false)
    expect(offered(undefined)).toBe(false)
  })
})
