import type { TerminalAttached, TerminalEvent } from "@novadeck/protocol"
import * as fc from "fast-check"

import { describe, expect, it } from "../test.js"
import { ptyOptions } from "../testing/pty.js"
import { Terminals } from "./manager.js"

type Mode = "control" | "observe"
type Model = { controller: number | undefined; attached: Map<number, Mode> }
type Attachment = {
  stream: AsyncGenerator<TerminalAttached | TerminalEvent>
  signal: AbortController
}
type Real = { manager: Terminals; id: string; attached: Map<number, Attachment> }
type Action =
  | { type: "attach"; client: number; mode: Mode }
  | { type: "release" | "cancel" | "probe"; client: number }

const owner = (client: number): string => `client-${client}`

const permissions = async (model: Model, real: Real): Promise<void> => {
  for (const client of [0, 1, 2]) {
    const input = { terminalId: real.id, data: "" }
    if (model.controller === client)
      expect(() => real.manager.write(input, owner(client))).not.toThrow()
    else {
      expect(() => real.manager.write(input, owner(client))).toThrow(
        expect.objectContaining({ code: "CONTROL_REQUIRED" }),
      )
      expect(() =>
        real.manager.resize({ terminalId: real.id, cols: 80, rows: 24 }, owner(client)),
      ).toThrow(expect.objectContaining({ code: "CONTROL_REQUIRED" }))
      // eslint-disable-next-line no-await-in-loop -- Each client's denied capability is checked independently.
      await expect(
        real.manager.close({ terminalId: real.id }, owner(client)),
      ).rejects.toMatchObject({
        code: "CONTROL_REQUIRED",
      })
    }
  }
  expect(real.manager.get(real.id).status).toBe("running")
}

class Step implements fc.AsyncCommand<Model, Real> {
  constructor(private readonly action: Action) {}

  check(): boolean {
    return true
  }

  async run(model: Model, real: Real): Promise<void> {
    const { client } = this.action
    if (this.action.type === "attach") {
      const { mode } = this.action
      const signal = new AbortController()
      const stream = real.manager.attach(
        { terminalId: real.id, mode },
        owner(client),
        signal.signal,
      )
      const error = model.attached.has(client)
        ? "ALREADY_ATTACHED"
        : mode === "control" && model.controller !== undefined && model.controller !== client
          ? "CONTROL_IN_USE"
          : undefined
      if (error) await expect(stream.next()).rejects.toMatchObject({ code: error })
      else {
        expect((await stream.next()).value).toEqual({ type: "attached", terminalId: real.id, mode })
        const { value: event } = await stream.next()
        if (event?.type !== "snapshot") throw new Error(`Expected a snapshot, got ${event?.type}`)
        expect(event).toMatchObject({ status: "running" })
        real.manager.ack({ terminalId: real.id, sequence: event.sequence }, owner(client))
        real.attached.set(client, { stream, signal })
        model.attached.set(client, mode)
        if (mode === "control") model.controller = client
        else if (model.controller === client) model.controller = undefined
      }
    } else if (this.action.type === "release" || this.action.type === "cancel") {
      const attachment = real.attached.get(client)
      if (this.action.type === "release") real.manager.release(owner(client))
      else attachment?.signal.abort()
      if (attachment) {
        await attachment.stream.return(undefined)
        real.attached.delete(client)
        model.attached.delete(client)
      }
      if (
        model.controller === client &&
        (this.action.type === "release" || attachment !== undefined)
      )
        model.controller = undefined
    }
    await permissions(model, real)
  }

  toString(): string {
    return JSON.stringify(this.action)
  }
}

const commands = fc.commands(
  [
    fc
      .record({
        type: fc.constant("attach" as const),
        client: fc.integer({ min: 0, max: 2 }),
        mode: fc.constantFrom("control" as const, "observe" as const),
      })
      .map((action) => new Step(action)),
    fc
      .record({
        type: fc.constantFrom("release" as const, "cancel" as const, "probe" as const),
        client: fc.integer({ min: 0, max: 2 }),
      })
      .map((action) => new Step(action)),
  ],
  { maxCommands: 24 },
)

describe("generated terminal ownership sequences", () => {
  it("keeps a single controller and revokes capabilities as clients attach, cancel, and disconnect", async ({
    resources,
  }) => {
    const manager = new Terminals(ptyOptions)
    resources.defer(() => manager.shutdown())
    const terminal = await manager.create(
      { sessionId: "model", cwd: process.cwd(), cols: 80, rows: 24 },
      "creator",
    )
    manager.release("creator")
    await fc.assert(
      fc.asyncProperty(commands, async (sequence) => {
        const model: Model = { controller: undefined, attached: new Map() }
        const real: Real = { manager, id: terminal.id, attached: new Map() }
        try {
          await fc.asyncModelRun(() => ({ model, real }), sequence)
        } finally {
          for (const client of [0, 1, 2]) manager.release(owner(client))
          await Promise.all(
            [...real.attached.values()].map(({ stream }) => stream.return(undefined)),
          )
        }
      }),
      { numRuns: 70 },
    )
  })
})
