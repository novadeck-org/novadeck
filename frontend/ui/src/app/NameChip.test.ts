import type { Murmur, MurmurState } from "@novadeck/core/murmur"
import { createStore } from "@novadeck/core/store"
import type { AgentStatus } from "@novadeck/core/types"
import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { openCommands } from "../test/commands"
import { WorkspaceServicesContext, type WorkspaceServices } from "./controller/context"
import { nameFinished } from "./murmur-offer"
import { NameChip } from "./NameChip"
import { watchFinishes } from "./ui-store"

const offered: MurmurState = {
  available: true,
  installed: false,
  enabled: false,
  wanted: true,
  sizes: { engine: 34 * 1024 * 1024, model: 1222 * 1024 * 1024 },
  installing: null,
  check: null,
  unsupported: null,
  offers: 0,
  refused: null,
  failure: null,
  stopped: null,
}

const target = { projectId: "project", workspaceSessionId: "initial" }
const finished = { context: "project/initial", id: "02" }

// The services the chip and the offer on a finish read: the real stores and commands over a
// fixture (test/commands.ts), and a murmur that records.
const setup = () => {
  const noteOffered = vi.fn<() => void>()
  const { workspace, ui, commands } = openCommands({ murmur: { noteOffered } })
  workspace.dispatch({
    type: "view/change",
    target,
    view: "focus",
    enabledViews: ["focus", "grid"],
  })
  const murmur: Murmur = {
    state: createStore(offered),
    install: () => Promise.resolve(),
    cancel: vi.fn<() => void>(),
    uninstall: () => Promise.resolve(),
    set: vi.fn<Murmur["set"]>(),
    noteOffered,
  }
  const services = { backend: { murmur }, workspace, ui, commands } as unknown as WorkspaceServices
  const status = (agent: AgentStatus) =>
    workspace.dispatch({
      type: "terminal/status",
      target,
      terminalId: "02",
      status: { state: "running", agent },
    })
  const mount = () =>
    render(
      createElement(
        WorkspaceServicesContext.Provider,
        { value: services },
        createElement(NameChip, { terminalId: "02", context: "project/initial" }),
      ),
    )
  return { workspace, ui, noteOffered, commands, status, mount, services }
}

const chip = () => document.querySelector<HTMLButtonElement>("button.name-chip")

describe("the offer chip takes the run's one unasked offer", () => {
  it("counts the session when it is drawn, once, though it is drawn again", () => {
    const { ui, noteOffered, commands, mount } = setup()
    commands.offerNameTo(finished)
    const first = mount()
    expect(chip()).not.toBeNull()
    expect(noteOffered).toHaveBeenCalledOnce()
    expect(ui.getSnapshot().addonOffer).toBe("murmur")
    first.unmount()

    // A switch of view draws the window again: it is not counted twice.
    const second = mount()
    expect(chip()).not.toBeNull()
    expect(noteOffered).toHaveBeenCalledOnce()
    second.unmount()
  })

  it("is not drawn when voice input's offer took the run first, and counts nothing", () => {
    const { noteOffered, commands, mount } = setup()
    commands.takeAddonOffer("voice")
    commands.offerNameTo(finished)
    const { unmount } = mount()

    expect(chip()).toBeNull()
    expect(noteOffered).not.toHaveBeenCalled()
    unmount()
  })

  it("stays when voice input's offer comes after, as it was asked for", () => {
    const { ui, noteOffered, commands, mount } = setup()
    commands.offerNameTo(finished)
    const { unmount } = mount()

    expect(commands.takeAddonOffer("voice")).toBe(false)
    expect(chip()).not.toBeNull()
    expect(ui.getSnapshot().addonOffer).toBe("murmur")
    expect(noteOffered).toHaveBeenCalledOnce()
    unmount()
  })
})

describe("the offer on a finished turn", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // What the app wires: the finish hook of `watchFinishes`, graced for 100 ms here.
  const watching = (setupped: ReturnType<typeof setup>) =>
    watchFinishes(setupped.workspace, setupped.ui, {
      graceMs: 100,
      finished: nameFinished(setupped.services),
    })
  const finish = async (status: ReturnType<typeof setup>["status"]) => {
    status({ working: true })
    status({ working: false, lastTurn: { outcome: "completed", reply: "Done.", at: 10 } })
    await vi.advanceTimersByTimeAsync(1000)
  }

  it("targets the terminal when it is shown under its plain name, and counts nothing yet", async () => {
    const offer = setup()
    offer.workspace.dispatch({ type: "terminal/select", target, terminalId: "02" })
    const stop = watching(offer)
    await finish(offer.status)

    expect(offer.ui.getSnapshot().nameOffer).toEqual(finished)
    expect(offer.ui.getSnapshot().addonOffer).toBeNull()
    expect(offer.noteOffered).not.toHaveBeenCalled()
    stop()
  })

  it("lets go of a terminal whose title someone gave", async () => {
    const offer = setup()
    offer.workspace.dispatch({ type: "terminal/select", target, terminalId: "02" })
    offer.workspace.dispatch({
      type: "terminal/update",
      target,
      terminalId: "02",
      titleSource: { kind: "person" },
    })
    const stop = watching(offer)
    await finish(offer.status)

    expect(offer.ui.getSnapshot().nameOffer).toBeNull()
    expect(offer.noteOffered).not.toHaveBeenCalled()
    stop()
  })

  it("lets go of a terminal that is not the one Focus shows", async () => {
    const offer = setup()
    offer.workspace.dispatch({ type: "terminal/select", target, terminalId: "01" })
    const stop = watching(offer)
    await finish(offer.status)

    expect(offer.ui.getSnapshot().nameOffer).toBeNull()
    stop()
  })

  it("targets nothing once voice input's offer has the run", async () => {
    const offer = setup()
    offer.workspace.dispatch({ type: "terminal/select", target, terminalId: "02" })
    offer.commands.takeAddonOffer("voice")
    const stop = watching(offer)
    await finish(offer.status)

    expect(offer.ui.getSnapshot().nameOffer).toBeNull()
    expect(offer.noteOffered).not.toHaveBeenCalled()
    stop()
  })

  it("tells nothing of a turn that failed", async () => {
    const offer = setup()
    offer.workspace.dispatch({ type: "terminal/select", target, terminalId: "02" })
    const stop = watching(offer)
    offer.status({ working: true })
    offer.status({ working: false, lastTurn: { outcome: "failed", at: 10 } })
    await vi.advanceTimersByTimeAsync(1000)

    expect(offer.ui.getSnapshot().nameOffer).toBeNull()
    stop()
  })
})
