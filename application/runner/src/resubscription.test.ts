import { MessageChannel } from "node:worker_threads"

import { contract, type TranscriptChange } from "@novadeck/protocol"
import { connectRunner, messagePort } from "@novadeck/protocol/client"
import { implement, ORPCError } from "@orpc/server"
import { RPCHandler } from "@orpc/server/message-port"

import { describe, expect, it } from "./test.js"

const item = (text: string): TranscriptChange => ({
  type: "items",
  items: [
    {
      index: 0,
      at: null,
      role: "user",
      kind: "text",
      text,
      truncated: false,
      tool: null,
      call: null,
    },
  ],
})

describe("a client's transcript across its runner's streams", () => {
  it("says it starts over only when a new stream has items, and ends once none is found", async ({
    resources,
  }) => {
    const api = implement(contract)
    // The runner ends each stream, as when the agent leaves the session; then the actor
    // is gone.
    const streams = [[item("first")], [item("again")]]
    const router = {
      runner: {
        handshake: api.runner.handshake.handler(() => ({
          runnerId: crypto.randomUUID(),
          protocolVersion: 1 as const,
        })),
      },
      agents: {
        transcript: api.agents.transcript.handler(async function* () {
          const changes = streams.shift()
          if (!changes) throw new ORPCError("NOT_FOUND", { status: 404, message: "Gone." })
          yield* changes
        }),
      },
    }
    const { port1, port2 } = new MessageChannel()
    new RPCHandler(router as never).upgrade(port1, { context: {} })
    port1.start()
    resources.defer(() => {
      port1.close()
      port2.close()
    })
    const client = await connectRunner(messagePort(port2), { retryDelay: () => 10 })
    resources.defer(() => client.close())
    const seen: string[] = []
    for await (const change of client.agents.transcript(crypto.randomUUID(), "a".repeat(16)))
      seen.push(change.type === "reset" ? "reset" : change.items[0]!.text)
    expect(seen).toEqual(["first", "reset", "again"])
  })
})
