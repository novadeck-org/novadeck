import { vi } from "vitest"

import type { AgentName } from "../model/harnesses"
import { createStore } from "../model/store"
import type { UninstallResult } from "../model/uninstall"
import { context, describe, expect, it } from "../test"
import type { AgentSwitch } from "./AgentSwitches"
import {
  agentList,
  askUninstall,
  chooseKeepData,
  confirmLabel,
  disconnectAgent,
  disconnectedNote,
  dismissible,
  namedAgents,
  noteDisconnected,
  removalText,
  runUninstall,
  settleUninstall,
  startUninstall,
} from "./uninstall"

describe("the uninstall dialog", () => {
  it("opens keeping the person's data, which they can turn off and on", () => {
    const opened = askUninstall()
    expect(opened.keepData).toBe(true)
    const off = chooseKeepData(opened, false)
    expect(off.keepData).toBe(false)
    expect(chooseKeepData(off, true).keepData).toBe(true)
  })

  it("is busy while it works, and cannot be left or changed then", () => {
    const busy = startUninstall(askUninstall())
    expect(busy).toMatchObject({ busy: true, error: null })
    expect(dismissible(busy)).toBe(false)
    expect(chooseKeepData(busy, false).keepData).toBe(true)
  })

  it("stays open with the reason when the removal fails, ready to try again", () => {
    const failed = settleUninstall(startUninstall(askUninstall()), {
      kind: "failed",
      reason: "Disk busy.",
    })
    expect(failed).toMatchObject({ busy: false, error: "Disk busy.", outcome: null })
    expect(dismissible(failed)).toBe(true)
    expect(startUninstall(failed).error).toBeNull()
  })

  it("ends in the outcome when the app is closing or gone, with nothing more to leave by", () => {
    const closing = settleUninstall(startUninstall(askUninstall()), { kind: "uninstalling" })
    expect(closing.outcome).toEqual({ kind: "uninstalling" })
    expect(dismissible(closing)).toBe(false)
    const removed = settleUninstall(startUninstall(askUninstall()), {
      kind: "removed",
      leftover: "sudo rm x",
    })
    expect(removed.outcome).toEqual({ kind: "removed", leftover: "sudo rm x" })
    expect(dismissible(removed)).toBe(false)
    expect(chooseKeepData(removed, false).keepData).toBe(true)
  })
})

describe("what the dialog says", () => {
  it("confirms with Continue where the platform's uninstaller finishes, else Uninstall", () => {
    const plan = { kind: "ready", dataFolders: [], handoff: "app" } as const
    expect(confirmLabel(plan)).toBe("Uninstall")
    expect(confirmLabel({ ...plan, handoff: "uninstaller" })).toBe("Continue")
  })

  it("names the connected agents, and drops the sentence when none is", () => {
    expect(removalText([])).toBe("Novadeck is removed from this computer.")
    expect(removalText(["claude"])).toBe(
      "Novadeck is removed from this computer and disconnected from Claude Code.",
    )
    expect(agentList(["claude", "codex", "agy"])).toBe("Claude Code, Codex and Antigravity")
  })
})

const switchFor = (agent: AgentName, connected: boolean): AgentSwitch => ({
  agent,
  available: true,
  connected,
  busy: false,
})

describe("disconnecting an agent", () => {
  const setup = (
    after: (current: AgentSwitch) => AgentSwitch,
    connected = true,
  ): {
    readonly agents: Parameters<typeof disconnectAgent>[0]
    readonly set: ReturnType<typeof vi.fn<(agent: AgentName) => void>>
  } => {
    const state = createStore<readonly AgentSwitch[]>([switchFor("claude", connected)])
    const set = vi.fn<(agent: AgentName) => void>((agent) => {
      state.update((list) => list.map((item) => ({ ...item, busy: true })))
      // The backend answers later, through its state.
      setTimeout(
        () =>
          state.update((list) => list.map((item) => (item.agent === agent ? after(item) : item))),
        0,
      )
    })
    return { agents: { state, set }, set }
  }

  it("waits for the change to settle, and says nothing once it is off", async () => {
    const { agents, set } = setup((item) => ({ ...item, busy: false, connected: false }))
    expect(await disconnectAgent(agents, "claude")).toBeUndefined()
    expect(set).toHaveBeenCalledWith("claude", false)
  })

  it("gives the backend's error when it stays connected", async () => {
    const { agents } = setup((item) => ({ ...item, busy: false, error: "Permission denied." }))
    expect(await disconnectAgent(agents, "claude")).toBe("Permission denied.")
  })

  it("leaves an agent that is already off alone", async () => {
    const { agents, set } = setup((item) => item, false)
    expect(await disconnectAgent(agents, "claude")).toBeUndefined()
    expect(set).not.toHaveBeenCalled()
  })
})

describe("running an uninstall", () => {
  const removed: UninstallResult = { kind: "removed" }

  context("with agents connected", () => {
    it("disconnects them one by one, then removes the app with the data choice", async () => {
      const order: string[] = []
      const result = await runUninstall({
        connected: ["claude", "codex"],
        disconnect: (agent) => {
          order.push(`disconnect ${agent}`)
          return Promise.resolve(undefined)
        },
        uninstall: ({ keepData }) => {
          order.push(`uninstall keepData=${keepData}`)
          return Promise.resolve(removed)
        },
        keepData: false,
      })
      expect(result).toEqual(removed)
      expect(order).toEqual(["disconnect claude", "disconnect codex", "uninstall keepData=false"])
    })

    it("stops at the first agent that stays connected, before the app is touched", async () => {
      const disconnect = vi.fn<(agent: AgentName) => Promise<string | undefined>>((agent) =>
        Promise.resolve(agent === "claude" ? "Permission denied." : undefined),
      )
      const uninstall = vi.fn<() => Promise<UninstallResult>>(() => Promise.resolve(removed))
      const result = await runUninstall({
        connected: ["claude", "codex"],
        disconnect,
        uninstall,
        keepData: true,
      })
      expect(result).toEqual({
        kind: "failed",
        reason: "Couldn't disconnect Claude Code: Permission denied.",
      })
      expect(disconnect).toHaveBeenCalledTimes(1)
      expect(uninstall).not.toHaveBeenCalled()
    })
  })

  it("removes the app at once when no agent is connected", async () => {
    const disconnect = vi.fn<() => Promise<undefined>>(() => Promise.resolve(undefined))
    const result = await runUninstall({
      connected: [],
      disconnect,
      uninstall: () => Promise.resolve({ kind: "uninstalling" }),
      keepData: true,
    })
    expect(result).toEqual({ kind: "uninstalling" })
    expect(disconnect).not.toHaveBeenCalled()
  })
})

describe("the agents a failed removal had disconnected", () => {
  it("are kept by the dialog, named once, and told of in a note", () => {
    const dialog = noteDisconnected(noteDisconnected(askUninstall(), "claude"), "claude")
    expect(dialog.disconnected).toEqual(["claude"])
    expect(disconnectedNote(dialog.disconnected)).toBe(
      "Claude Code was disconnected; connect it again in Preferences if you keep Novadeck.",
    )
    expect(disconnectedNote(["claude", "codex"])).toMatch(
      /Claude Code and Codex were disconnected; connect them/,
    )
    expect(disconnectedNote([])).toBeUndefined()
    expect(namedAgents(dialog, ["codex", "claude"])).toEqual(["claude", "codex"])
  })

  it("are reported by runUninstall as each is disconnected, up to the one that fails", async () => {
    const told: AgentName[] = []
    await runUninstall({
      connected: ["claude", "codex"],
      disconnect: (agent) => Promise.resolve(agent === "codex" ? "Denied." : undefined),
      uninstall: () => Promise.resolve({ kind: "removed" }),
      keepData: true,
      onDisconnected: (agent) => told.push(agent),
    })
    expect(told).toEqual(["claude"])
  })
})
