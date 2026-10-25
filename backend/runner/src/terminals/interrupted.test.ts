import { describe, expect, it } from "vitest"

import { interruptedFor, interruptedNotice } from "./interrupted.js"
import type { Record } from "./record.js"

type Held = Pick<Record, "resumeClaim" | "resumeTold" | "root" | "transcript" | "bound">

const root = { agent: "claude", sessionId: "s1", instance: "1", source: "binding" } as const
const resumed = (extra: Partial<Held> = {}): Held => ({
  resumeClaim: "claude:s1",
  resumeTold: undefined,
  root,
  transcript: "/t.jsonl",
  bound: null,
  ...extra,
})
const read = async () => ["line"]

describe("the notice to a resumed agent whose turn the stop cut short", () => {
  it("tells one whose transcript says its turn was cut, once", async () => {
    const record = resumed()
    expect(await interruptedFor(record, () => true, read)).toBe(interruptedNotice)
    expect(record.resumeTold).toBe(true)
    expect(await interruptedFor(record, () => true, read)).toBeUndefined()
  })

  it("tells nothing of an agent that was idle, waiting on the person or ended by an error", async () => {
    const record = resumed()
    expect(await interruptedFor(record, () => false, read)).toBeUndefined()
    // Judged once, so a later session in the terminal is never told.
    expect(record.resumeTold).toBe(true)
  })

  it("tells nothing where no shell resumed an agent, or its harness cannot say", async () => {
    expect(
      await interruptedFor(resumed({ resumeClaim: undefined }), () => true, read),
    ).toBeUndefined()
    expect(await interruptedFor(resumed(), undefined, read)).toBeUndefined()
    expect(await interruptedFor(resumed({ transcript: null }), () => true, read)).toBeUndefined()
  })

  it("tells nothing of another agent than the one resumed, or an unreadable transcript", async () => {
    expect(
      await interruptedFor(resumed({ resumeClaim: "codex:s1" }), () => true, read),
    ).toBeUndefined()
    expect(
      await interruptedFor(
        resumed(),
        () => true,
        async () => undefined,
      ),
    ).toBeUndefined()
  })

  it("tells nothing once a turn runs meanwhile or the root moved", async () => {
    const working = {
      state: "working",
      background: null,
    } as unknown as NonNullable<Held["bound"]>["activity"]
    const bound = { activity: working } as unknown as Held["bound"]
    expect(await interruptedFor(resumed({ bound }), () => true, read)).toBeUndefined()
    const record = resumed()
    const moving = async () => {
      record.root = { ...root, sessionId: "s2" }
      return ["line"]
    }
    expect(await interruptedFor(record, () => true, moving)).toBeUndefined()
  })
})
