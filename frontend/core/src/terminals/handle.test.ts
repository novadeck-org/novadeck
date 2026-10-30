import { describe as context, describe, expect, it } from "vitest"

import type { TerminalStatus } from "../types"
import { showsHandle } from "./handle"

const idle: TerminalStatus = { state: "idle" }

describe("showsHandle", () => {
  context("for a shell the person opened that no agent touched", () => {
    it("keeps the handle off its tab", () => {
      expect(showsHandle(idle)).toBe(false)
      expect(showsHandle({ ...idle, openedBy: null, ledBy: null, agentRan: false })).toBe(false)
      expect(showsHandle({ state: "running" })).toBe(false)
    })
  })

  context("for a terminal agents name by its handle", () => {
    it("shows it while an agent runs there", () => {
      expect(showsHandle({ state: "running", agent: { working: true } })).toBe(true)
    })

    it("keeps showing it once an agent has run there and exited", () => {
      expect(showsHandle({ ...idle, agentRan: true })).toBe(true)
    })

    it("shows it on a shell an agent opened, or one an agent leads", () => {
      expect(showsHandle({ ...idle, openedBy: "moth" })).toBe(true)
      expect(showsHandle({ ...idle, ledBy: "moth" })).toBe(true)
    })
  })
})
