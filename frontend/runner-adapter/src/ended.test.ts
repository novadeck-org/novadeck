import type { ConnectFailure } from "@novadeck/core/port"
import { WireError } from "@novadeck/wire"
import type { WireStatus } from "@novadeck/wire/client"
import { vi } from "vitest"

import { watchEnd } from "./index"
import { context, describe, expect, it } from "./test"

// A runner whose status goes through `statuses`, then stays at the last.
const runnerThrough = (statuses: readonly WireStatus[]) => ({
  status: statuses.at(-1)!,
  async *watch() {
    for (const status of statuses) {
      // eslint-disable-next-line no-await-in-loop -- One status at a time, as the link changes.
      await Promise.resolve()
      yield status
    }
  },
})

const revoked = new WireError("UNAUTHORIZED", "Unauthorized", { data: { reason: "revoked" } })
const connected: WireStatus = { state: "connected", epoch: "e" }

const heard = async (statuses: readonly WireStatus[], stop = false) => {
  const told = vi.fn<(failure: ConnectFailure) => void>()
  const stopped = watchEnd(runnerThrough(statuses) as never, told)
  if (stop) stopped()
  // The statuses pass a microtask apart: a timer's turn sees them all.
  await new Promise((resolve) => setTimeout(resolve, 10))
  return told
}

describe("a link's end", () => {
  context("when the runner refuses it for good once connected", () => {
    it("says why once, as that this device was signed out", async () => {
      const told = await heard([
        connected,
        { state: "reconnecting", error: new WireError("DISCONNECTED") },
        { state: "closed", error: revoked },
      ])
      expect(told).toHaveBeenCalledOnce()
      expect(told.mock.calls[0]![0]).toMatchObject({ kind: "unauthorized", revoked: true })
    })
  })

  context("when it ends any other way", () => {
    it("says nothing of one closed here, or one the desktop app replaces", async () => {
      expect(await heard([connected, { state: "closed" }])).not.toHaveBeenCalled()
      expect(
        await heard([connected, { state: "closed", error: new WireError("CLOSED") }]),
      ).not.toHaveBeenCalled()
    })

    it("says nothing once told to stop listening", async () => {
      expect(
        await heard([connected, { state: "closed", error: revoked }], true),
      ).not.toHaveBeenCalled()
    })
  })
})
