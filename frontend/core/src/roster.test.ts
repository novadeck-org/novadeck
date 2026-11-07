import { createRoster, setTerminalStatus } from "./roster"
import { describe, expect, it } from "./test"
import type { TerminalMetadata, TerminalStatus } from "./types"

// Every field of a terminal that no status carries: what it is, beside what it is doing.
type KeysOf<T> = T extends unknown ? keyof T : never
type IdentityKey = Exclude<KeysOf<TerminalMetadata>, KeysOf<TerminalStatus> | "itemId">

describe("a terminal's status", () => {
  it("keeps every field that is not the status's own", () => {
    // Naming every identity field: one added to `TerminalMetadata` fails to typecheck here
    // until it is set, and then fails below until a status change keeps it.
    const identity = {
      id: "01",
      name: "Terminal 1",
      directory: "/work/app",
      command: "bash",
      process: "bash",
      restoredProcess: "claude",
      handle: "moth",
      ledBy: "fox",
      openedBy: "owl",
      agentRan: true,
      titleSource: { kind: "agent", by: "fox" },
    } satisfies Required<Pick<TerminalMetadata, IdentityKey>>
    const roster = createRoster([
      {
        ...identity,
        state: "exited",
        exitCode: 1,
        signal: null,
        cause: "out-of-memory",
      },
    ])

    const [terminal] = setTerminalStatus(roster, "01", {
      state: "starting",
    }).terminals
    expect(terminal).toEqual({ ...identity, state: "starting" })
  })

  it("names the agent a sleeper resumes once it wakes, and clears it once a shell reports", () => {
    const roster = createRoster([
      { id: "01", name: "Checkout", directory: "/work", command: "", process: "", state: "idle" },
    ])
    const asleep = setTerminalStatus(roster, "01", { state: "sleeping", agent: "claude" })
    expect(asleep.terminals[0]).toMatchObject({ state: "sleeping", agent: "claude" })
    const waking = setTerminalStatus(asleep, "01", { state: "starting" })
    expect(waking.terminals[0]).toMatchObject({ state: "starting", restoredProcess: "claude" })
    const awake = setTerminalStatus(waking, "01", { state: "idle" })
    expect(awake.terminals[0]).not.toHaveProperty("restoredProcess")
  })
})
