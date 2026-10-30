import type { MurmurState } from "@novadeck/core/addons/murmur"
import { createWorkspaceStore } from "@novadeck/core/store"
import { workspaceFixture } from "@novadeck/core/testing"

import { describe, expect, it } from "../test"
import {
  offerable,
  offerDue,
  offerSessions,
  canCarryChip,
  offerText,
  plainTitle,
} from "./murmur-offer"

const offered: MurmurState = {
  available: true,
  installed: false,
  enabled: false,
  wanted: true,
  sizes: { engine: 34 * 1024 * 1024, model: 1222 * 1024 * 1024 },
  installing: null,
  check: null,
  kept: false,
  unsupported: null,
  offers: 0,
  refused: null,
  failure: null,
  stopped: null,
}

describe("the Murmur offer's conditions", () => {
  it("stands for a computer with the engine, no install, and no refusal", () => {
    expect(offerable(offered)).toBe(true)
    expect(offerDue(offered)).toBe(true)
  })

  it.each([
    ["installed", { installed: true }],
    ["declined", { wanted: false }],
    [
      "known not to run murmur",
      { unsupported: { reason: "No graphics device answered.", source: "check" as const } },
    ],
    ["without an engine for the platform", { available: false }],
    [
      "installing",
      {
        installing: {
          step: "engine" as const,
          received: 0,
          total: 1,
          origin: "person" as const,
        },
      },
    ],
    ["after a failure", { failure: "Couldn't reach the download." }],
  ])("does not stand when %s", (_name, change) => {
    expect(offerable({ ...offered, ...change })).toBe(false)
  })

  it("is due until it was shown in three sessions, though it still stands", () => {
    expect(offerDue({ ...offered, offers: offerSessions - 1 })).toBe(true)
    expect(offerable({ ...offered, offers: offerSessions })).toBe(true)
    expect(offerDue({ ...offered, offers: offerSessions })).toBe(false)
  })
})

describe("which titles the chip is offered beside", () => {
  it("takes the plain name of the agent or program, not one anyone gave", () => {
    expect(plainTitle({})).toBe(true)
    expect(plainTitle({ titleSource: { kind: "default" } })).toBe(true)
    expect(plainTitle({ titleSource: { kind: "person" } })).toBe(false)
    expect(plainTitle({ titleSource: { kind: "agent", by: "claude" } })).toBe(false)
    expect(plainTitle({ titleSource: { kind: "murmur" } })).toBe(false)
  })
})

describe("which finished terminal may carry the chip", () => {
  const target = { projectId: "project", workspaceSessionId: "initial" }
  const finished = { context: "project/initial", id: "02" }

  const inView = (view: "focus" | "grid") => {
    const workspace = createWorkspaceStore(workspaceFixture())
    workspace.dispatch({
      type: "view/change",
      target,
      view,
      enabledViews: ["focus", "grid", "canvas"],
    })
    workspace.dispatch({ type: "terminal/select", target, terminalId: "01" })
    return workspace
  }

  it("takes the one shown in Focus, under its plain name", () => {
    const workspace = inView("focus")
    workspace.dispatch({ type: "terminal/select", target, terminalId: "02" })
    expect(canCarryChip(workspace.getSnapshot(), finished)).toBe(true)
  })

  it("lets go of a finish in Focus of a terminal that is not the one shown", () => {
    expect(canCarryChip(inView("focus").getSnapshot(), finished)).toBe(false)
  })

  it("takes any terminal in Grid that is not hidden from it", () => {
    const workspace = inView("grid")
    expect(canCarryChip(workspace.getSnapshot(), finished)).toBe(true)
    workspace.dispatch({ type: "terminal/visibility", target, terminalId: "02", hidden: true })
    expect(canCarryChip(workspace.getSnapshot(), finished)).toBe(false)
  })

  it("lets go of a title someone gave", () => {
    const workspace = createWorkspaceStore(workspaceFixture())
    workspace.dispatch({ type: "terminal/select", target, terminalId: "02" })
    for (const titleSource of [
      { kind: "person" },
      { kind: "agent", by: "claude" },
      { kind: "murmur" },
    ] as const) {
      workspace.dispatch({ type: "terminal/update", target, terminalId: "02", titleSource })
      expect(canCarryChip(workspace.getSnapshot(), finished)).toBe(false)
    }
  })

  it("lets go of a finish in a session that is not on screen, or a terminal that is gone", () => {
    const workspace = createWorkspaceStore(workspaceFixture())
    workspace.dispatch({ type: "terminal/select", target, terminalId: "02" })
    expect(canCarryChip(workspace.getSnapshot(), { context: "other/background", id: "02" })).toBe(
      false,
    )
    expect(canCarryChip(workspace.getSnapshot(), { ...finished, id: "99" })).toBe(false)
  })
})

describe("what the offer says", () => {
  it("names the chip, and the popover's download size, never GPU", () => {
    expect(offerText.chip).toBe("Name it for me")
    expect(offerText.body(offered)).toBe(
      "A small model on this computer reads the agent's work and names each terminal. 1.2 GB once.",
    )
    expect(JSON.stringify(offerText)).not.toMatch(/GPU/)
  })
})
