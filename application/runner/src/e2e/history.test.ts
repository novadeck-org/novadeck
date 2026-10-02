import type { DeliveryState, MessageState, TerminalMessages } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { createHistory, named, transitions } from "./history.js"

// A listing of t2's messages: its delivery state and, when given, one message from t1.
const listing = (delivery: DeliveryState, state?: MessageState): TerminalMessages => ({
  terminalId: "terminal-2",
  handle: "t2",
  delivery,
  paused: false,
  threads:
    state === undefined
      ? []
      : [
          {
            id: "thread-1",
            peer: "t1",
            hops: 1,
            allowed: 8,
            held: false,
            messages: [
              {
                id: "m-1",
                thread: "thread-1",
                hop: 1,
                from: "t1",
                fromAgent: "claude",
                to: "t2",
                toAgent: "codex",
                text: "What is your colour?",
                sentAt: 0,
                state,
                held: null,
                deliveredAt: null,
              },
            ],
          },
        ],
})

describe("createHistory", () => {
  it("numbers each listing it records and keeps each message's state", () => {
    const history = createHistory("t2")
    history.push(listing("ready"))
    history.push(listing("ringing", "leased"))

    expect(history.mark()).toBe(2)
    expect(history.snapshots()).toEqual([
      expect.objectContaining({ index: 0, delivery: "ready", messages: [] }),
      expect.objectContaining({
        index: 1,
        delivery: "ringing",
        messages: [{ id: "m-1", from: "t1", to: "t2", state: "leased" }],
      }),
    ])
  })

  it("finds a state already passed through, however briefly", async () => {
    const history = createHistory("t2")
    for (const state of ["ready", "working", "settled"] as const) history.push(listing(state))

    expect((await history.reached("working")).index).toBe(1)
  })

  it("waits for a state reached later, as soon as it is recorded", async () => {
    const history = createHistory("t2")
    history.push(listing("ready"))
    const working = history.reached("working")

    history.push(listing("working"))

    expect(await working).toMatchObject({ index: 1, delivery: "working" })
  })

  it("counts only snapshots from a mark on, and takes a test of the snapshot", async () => {
    const history = createHistory("t2")
    history.push(listing("settled"))
    const mark = history.mark()
    const delivered = history.reached(
      (snapshot) => snapshot.messages.some((message) => message.state === "delivered"),
      { after: mark },
    )
    const settled = history.reached("settled", { after: mark })

    history.push(listing("working", "delivered"))
    history.push(listing("settled", "delivered"))

    expect((await delivered).index).toBe(1)
    expect((await settled).index).toBe(2)
  })

  it("fails on timeout with the states gone through since the mark", async () => {
    const history = createHistory("t2")
    history.push(listing("fresh"))
    history.push(listing("ready"))
    const mark = history.mark()
    history.push(listing("ringing", "leased"))
    history.push(listing("unknown", "delivered"))

    await expect(history.reached("working", { after: mark, timeoutMs: 20 })).rejects.toThrow(
      "t2 can't reach working: timed out after 20 ms. t2: ready → ringing → unknown; messages m-1 delivered",
    )
  })

  it("fails a wait still pending when it ends, and any asked for after", async () => {
    const history = createHistory("t2")
    history.push(listing("ready"))
    const pending = history.reached("working")

    history.end("its terminal is gone")
    history.push(listing("working"))

    await expect(pending).rejects.toThrow("t2 can't reach working: its terminal is gone")
    await expect(history.reached("working")).rejects.toThrow(/its terminal is gone/)
    expect(history.mark()).toBe(1)
  })
  it("fails only the wait whose test throws, with the test's own error", async () => {
    const history = createHistory("t2")
    history.push(listing("ready"))
    const broken = history.reached(
      () => {
        throw new Error("a broken test")
      },
      { after: 1 },
    )
    const working = history.reached("working")

    history.push(listing("working"))

    await expect(broken).rejects.toThrow("a broken test")
    await expect(working).resolves.toMatchObject({ delivery: "working" })
    history.push(listing("settled"))
    await expect(history.reached("settled")).resolves.toMatchObject({ index: 2 })
  })

  it("names a named test in what a failed wait says", async () => {
    const history = createHistory("t2")
    history.push(listing("ready"))

    await expect(
      history.reached(
        named("t1 → t2 delivered", () => false),
        { timeoutMs: 20 },
      ),
    ).rejects.toThrow("t2 can't reach t1 → t2 delivered: timed out after 20 ms")
  })
})

describe("transitions", () => {
  it("shows a delivery state that held while only a message changed once", () => {
    const history = createHistory("t2")
    history.push(listing("working", "queued"))
    history.push(listing("working", "delivered"))

    expect(transitions("t2", history.snapshots())).toBe("t2: working; messages m-1 delivered")
    expect(transitions("t2", [])).toBe("t2: (no change)")
  })
})
