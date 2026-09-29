import type { TerminalEvent } from "@novadeck/protocol"
import type { AttachedTerminal } from "@novadeck/protocol/client"
import { vi } from "vitest"

import { describe, expect, it } from "../../test"
import type { SurfaceRuntime } from "./backend"
import { followTerminal } from "./follow"

const key = { projectId: "p", workspaceSessionId: "s", terminalId: "t" }
const envelope = { terminalId: "t" }

// An attachment that replays `events`, then ends as the runner ends it after an exit.
const replaying = (events: readonly TerminalEvent[]): AttachedTerminal => {
  const queue = [...events]
  const attached: AttachedTerminal = {
    id: "t",
    mode: "control",
    [Symbol.asyncIterator]: () => attached,
    next: async () =>
      queue.length ? { value: queue.shift()!, done: false } : { value: undefined, done: true },
    return: async () => ({ value: undefined, done: true }),
    write: async () => {},
    resize: async () => {},
    detach: async () => {},
  }
  return attached
}

describe("following a runner terminal", () => {
  it("reports an exit only after drawing the output that came before it", async () => {
    const drawn: string[] = []
    const exit = { code: null, signal: "SIGKILL", ranMs: 500 }
    const entry = {
      ready: Promise.resolve(true),
      revived: new Promise<void>(() => {}),
      closed: false,
      size: { cols: 80, rows: 24 },
    }
    const runtime = {
      entry: () => entry,
      attach: async () =>
        replaying([
          { ...envelope, sequence: 1, type: "output", data: "kill -9" },
          { ...envelope, sequence: 2, type: "output", data: " $$\r\n" },
          { ...envelope, sequence: 3, type: "exited", exit },
        ]),
      resized: () => {},
      attached: () => () => {},
      connected: async () => {},
      lost: () => {},
      restart: () => {},
      exited: (_key, reported) => drawn.push(`runtime:${reported?.signal}`),
      connection: { getSnapshot: () => "connected", subscribe: () => () => {} },
      track: (work) => work,
      screen: () => {},
      shown: () => false,
    } satisfies SurfaceRuntime
    const followed = followTerminal(runtime, key, {
      write: async (data) => void drawn.push(data),
      reset: () => {},
      resize: () => {},
      fit: () => undefined,
      exited: (waits) => drawn.push(`hint:${waits}`),
      live: () => {},
    })
    await vi.waitFor(() => expect(drawn).toHaveLength(4))
    followed.stop()
    expect(drawn).toEqual(["kill -9", " $$\r\n", "runtime:SIGKILL", "hint:true"])
  })
})
