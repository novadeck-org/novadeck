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

const { useReleaseLead } = await import("./release-lead")

const led = { ...terminalFixture(4, "~/p"), ledBy: "moth", state: "running" as const }

const offered = (tile: object, releaseLead: Backend["releaseLead"] | null = () => {}) => {
  services.backend = releaseLead ? { releaseLead } : {}
  const result: unknown[] = []
  const Probe = (): null => {
    result.push(useReleaseLead(tile as never))
    return null
  }
  render(createElement(Probe))
  return result.at(-1) as { lead: string; onRelease: () => void } | undefined
}

describe("releasing a terminal from its lead", () => {
  it("is offered on a running terminal that a lead leads", () => {
    expect(offered(led)?.lead).toBe("moth")
  })

  it("releases through the backend with the terminal's key", () => {
    const releaseLead = vi.fn<NonNullable<Backend["releaseLead"]>>()
    offered(led, releaseLead)?.onRelease()
    expect(releaseLead).toHaveBeenCalledExactlyOnceWith({
      projectId: "p",
      workspaceSessionId: "s",
      terminalId: led.id,
    })
  })

  it("isn't offered while the shell starts", () => {
    expect(offered({ ...led, state: "starting" })).toBeUndefined()
  })

  it("isn't offered once the shell ended", () => {
    const exited = { ...led, state: "exited", exitCode: 0, signal: null }
    expect(offered(exited)).toBeUndefined()
    expect(offered({ ...led, state: "failed", message: "x" })).toBeUndefined()
  })

  it("isn't offered without a lead or on a backend that can't release", () => {
    expect(offered({ ...led, ledBy: null })).toBeUndefined()
    expect(offered(led, null)).toBeUndefined()
  })
})
