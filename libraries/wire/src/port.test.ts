import { oc, type } from "@orpc/contract"
import { implement } from "@orpc/server"
import { describe, expect, it, onTestFinished, vi } from "vitest"

import { connect } from "./connection.js"
import { wireContract } from "./handshake.js"
import { servePort, type ServedPort } from "./port.js"
import { createSessions, type Session, type SessionContext } from "./sessions.js"
import { memoryPorts } from "./testing.js"
import { messagePort } from "./transport.js"

const contract = {
  ...wireContract,
  echo: oc.input(type<string>()).output(type<string>()),
}

const protocolVersion = 1

const serve = () => {
  const closed = vi.fn<(session: Session) => void>()
  const failed = vi.fn<(path: readonly string[], error: unknown) => void>()
  const { wire: _, ...app } = contract
  const api = implement(app).$context<SessionContext>()
  const sessions = createSessions({
    protocolVersion,
    router: api.router({ echo: api.echo.handler(({ input }) => input) }),
    closed,
    failed,
  })
  const [end, client] = memoryPorts()
  const dispose = servePort(sessions, end as ServedPort)
  return { closed, failed, client, dispose }
}

describe("servePort", () => {
  it("refuses a call limit that isn't a positive integer", () => {
    const sessions = createSessions({ protocolVersion, router: {} })
    const [end] = memoryPorts()
    expect(() => servePort(sessions, end as ServedPort, { maxCalls: 0 })).toThrow("maxCalls")
  })

  it("serves the port's holder without a token", async () => {
    const { client } = serve()
    const wire = await connect({ contract, transport: messagePort(client), protocolVersion })
    onTestFinished(() => wire.close())
    await expect(wire.session().client.echo("hi")).resolves.toBe("hi")
  })

  it("tells the app of a message it can't read, and answers the next call as ever", async () => {
    const { client, failed } = serve()
    const wire = await connect({ contract, transport: messagePort(client), protocolVersion })
    onTestFinished(() => wire.close())
    // Neither a request nor encoded as one: oRPC's handler rejects on it, outside any call.
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- A port takes none.
    client.postMessage({})
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce())
    expect(failed.mock.calls[0]![0]).toEqual([])
    expect(failed.mock.calls[0]![1]).toBeInstanceOf(Error)
    await expect(wire.session().client.echo("hi")).resolves.toBe("hi")
  })

  it("ends the session when the port closes", async () => {
    const { client, closed } = serve()
    const wire = await connect({ contract, transport: messagePort(client), protocolVersion })
    onTestFinished(() => wire.close())
    wire.close()
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
  })

  it("closes the port and ends the session when disposed", async () => {
    const { client, closed, dispose } = serve()
    const wire = await connect({ contract, transport: messagePort(client), protocolVersion })
    onTestFinished(() => wire.close())
    dispose()
    expect(closed).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(wire.status.value.state).toBe("closed"))
  })
})
