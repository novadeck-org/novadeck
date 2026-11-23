import type { AgentConnection, Backend, TerminalRequest } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  connectInstalled,
  readInstalls,
  startInstalled,
  stepInstall,
  writeInstalls,
  type PendingInstall,
} from "./installs"

const pending: PendingInstall = { agent: "claude", terminalId: "03", ran: false }

describe("an install's terminal", () => {
  it("is not over before the installer was seen working", () => {
    expect(stepInstall(pending, { busy: false, directory: "~/app" })).toEqual({
      step: "running",
      install: pending,
    })
  })

  it("is seen working once it is busy, and over once it is not any more", () => {
    const working = stepInstall(pending, { busy: true, directory: "~/app" })
    expect(working).toEqual({ step: "running", install: { ...pending, ran: true } })
    const install = working.step === "running" ? working.install : pending
    expect(stepInstall(install, { busy: true, directory: "~/app" })).toEqual(working)
    expect(stepInstall(install, { busy: false, directory: "~/app" })).toEqual({ step: "finished" })
  })

  it("is over without a result when its terminal closed", () => {
    expect(stepInstall(pending, undefined)).toEqual({ step: "gone" })
    expect(stepInstall({ ...pending, ran: true }, undefined)).toEqual({ step: "gone" })
  })
})

// An agents backend that shows what a refresh finds, and connects after a moment.
const agentsBackend = (
  found: readonly AgentConnection[],
  connecting: "works" | "fails" = "works",
) => {
  const state = createStore<readonly AgentConnection[]>([
    { agent: "claude", available: false, connected: false, busy: false },
  ])
  const sets: [string, boolean][] = []
  const agents: NonNullable<Backend["agents"]> = {
    state,
    set: (agent, connected) => {
      sets.push([agent, connected])
      state.update((list) => list.map((item) => ({ ...item, busy: true })))
      setTimeout(
        () =>
          state.update((list) =>
            list.map((item) => ({
              ...item,
              busy: false,
              ...(connecting === "works" ? { connected } : { error: "denied" }),
            })),
          ),
        0,
      )
    },
    refresh: () => {
      state.update(() => found)
      return Promise.resolve()
    },
    welcome: createStore(false),
    finishWelcome: () => {},
  }
  return { agents, sets }
}

describe("a finished install", () => {
  it("connects the agent it installed, and is ready once connected", async () => {
    const { agents, sets } = agentsBackend([
      { agent: "claude", available: true, connected: false, busy: false },
    ])
    expect(await connectInstalled(agents, "claude")).toBe("ready")
    expect(sets).toEqual([["claude", true]])
  })

  it("leaves an agent that is still not installed alone, as its installer failed", async () => {
    const { agents, sets } = agentsBackend([
      { agent: "claude", available: false, connected: false, busy: false },
    ])
    expect(await connectInstalled(agents, "claude")).toBe("missing")
    expect(sets).toEqual([])
  })

  it("does not connect an agent that is connected already", async () => {
    const { agents, sets } = agentsBackend([
      { agent: "claude", available: true, connected: true, busy: false },
    ])
    expect(await connectInstalled(agents, "claude")).toBe("ready")
    expect(sets).toEqual([])
  })

  it("says so where connecting failed, which the agent's switch shows", async () => {
    const { agents } = agentsBackend(
      [{ agent: "claude", available: true, connected: false, busy: false }],
      "fails",
    )
    expect(await connectInstalled(agents, "claude")).toBe("unconnected")
    expect(agents.state.getSnapshot()[0]).toMatchObject({ error: "denied" })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe("the installs under way, kept for a reload", () => {
  it("are read back as they were written, and none is kept once there are none", () => {
    const installs: PendingInstall[] = [
      { agent: "claude", terminalId: "03", ran: true },
      { agent: "agy", terminalId: "04", ran: false },
      // One asked for by the tour: nothing is started for the person to sign in once it ends.
      { agent: "opencode", terminalId: "05", ran: false, quiet: true },
    ]
    writeInstalls(installs)
    expect(readInstalls()).toEqual(installs)
    writeInstalls([])
    expect(readInstalls()).toEqual([])
    expect(sessionStorage.length).toBe(0)
  })

  it("leave out what is not an install, and read as none from broken storage", () => {
    sessionStorage.setItem(
      "novadeck.installs",
      JSON.stringify([
        { agent: "claude", terminalId: "03", ran: true },
        { agent: "vim", terminalId: "04", ran: true },
        { agent: "codex", terminalId: 5, ran: true },
        "x",
      ]),
    )
    expect(readInstalls()).toEqual([{ agent: "claude", terminalId: "03", ran: true }])
    sessionStorage.setItem("novadeck.installs", "{ not json")
    expect(readInstalls()).toEqual([])
  })

  it("work without storage", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
      removeItem: () => {
        throw new Error("blocked")
      },
    })
    expect(readInstalls()).toEqual([])
    expect(() => writeInstalls([pending])).not.toThrow()
  })
})

describe("starting an installed agent", () => {
  const install: PendingInstall = { agent: "agy", terminalId: "03", ran: true }

  it("opens it beside the installer's terminal, in its folder, in view", () => {
    const requests: TerminalRequest[] = []
    const added: unknown[] = []
    startInstalled(
      {
        openRequested: (request) => {
          requests.push(request)
          request.answer({ terminalId: "08" })
        },
        add: (options) => {
          added.push(options)
          return "09"
        },
      },
      install,
      "~/app",
    )
    expect(requests).toMatchObject([
      { from: "03", directory: "~/app", command: "agy", focus: true },
    ])
    expect(added).toEqual([])
  })

  it("opens it in the project on screen where the installer's terminal closed meanwhile", () => {
    const added: unknown[] = []
    startInstalled(
      {
        openRequested: (request) =>
          request.answer({ reason: "The terminal that asked isn't open in Novadeck." }),
        add: (options) => {
          added.push(options)
          return "09"
        },
      },
      install,
      "~/app",
    )
    expect(added).toEqual([{ command: "agy" }])
  })
})
