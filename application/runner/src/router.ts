import { contract, errors as contractErrors, protocolVersion } from "@novadeck/protocol"
import { implement, ORPCError } from "@orpc/server"

import { DomainError } from "./errors.js"
import type { Terminals } from "./terminals/index.js"
import type { WorkspaceStore } from "./workspaces/store.js"

/** One client of a runner. Its transport decides how the handshake token is checked. */
export type Connection = {
  readonly id: string
  readonly verify: (token: string | undefined) => boolean
  /** Ends the transport, e.g. when a newer connection of the same client takes over. */
  readonly terminate: () => void
  readonly onAuthenticated: () => void
  clientId: string | undefined
  authenticated: boolean
  closed: boolean
  calls: number
}

type Context = { connection: Connection }

const apiError = (error: unknown): unknown =>
  error instanceof DomainError
    ? new ORPCError(error.code, {
        status: contractErrors[error.code].status,
        message: error.message,
      })
    : error

export const createRouter = (options: {
  runnerId: string
  claim: (connection: Connection, clientId: string) => void
  store: WorkspaceStore
  terminals: Terminals
}) => {
  const { store, terminals } = options
  const api = implement(contract).$context<Context>()
  const authorized = api.use(async ({ context, next }) => {
    const connection = context.connection
    if (!connection.authenticated || connection.closed) throw new ORPCError("UNAUTHORIZED")
    if (connection.calls >= 32) throw new ORPCError("RESOURCE_LIMIT", { status: 429 })
    connection.calls += 1
    try {
      return await next()
    } catch (error) {
      throw apiError(error)
    } finally {
      connection.calls -= 1
    }
  })

  return api.router({
    runner: {
      handshake: api.runner.handshake.handler(({ input, context, errors }) => {
        const connection = context.connection
        if (connection.closed || !connection.verify(input.token)) {
          throw errors.UNAUTHORIZED()
        }
        if (input.protocolVersion !== protocolVersion) throw errors.INCOMPATIBLE_PROTOCOL()
        connection.authenticated = true
        if (input.clientId !== undefined) options.claim(connection, input.clientId)
        connection.onAuthenticated()
        return {
          runnerId: options.runnerId,
          protocolVersion,
          capabilities: [
            "workspace-metadata",
            "terminal-replay",
            "terminal-ack",
            "terminal-observers",
          ],
        }
      }),
    },
    projects: {
      list: authorized.projects.list.handler(() => store.projects()),
      create: authorized.projects.create.handler(({ input }) => store.createProject(input)),
      rename: authorized.projects.rename.handler(({ input }) => store.renameProject(input)),
    },
    sessions: {
      list: authorized.sessions.list.handler(({ input }) => store.sessions(input.projectId)),
      create: authorized.sessions.create.handler(({ input }) => store.createSession(input)),
      rename: authorized.sessions.rename.handler(({ input }) => store.renameSession(input)),
    },
    terminals: {
      list: authorized.terminals.list.handler(({ input }) => {
        store.session(input.sessionId)
        return terminals.list(input.sessionId)
      }),
      create: authorized.terminals.create.handler(({ input, context }) => {
        const session = store.session(input.sessionId)
        const project = store.project(session.projectId)
        return terminals.create({ ...input, cwd: input.cwd ?? project.cwd }, context.connection.id)
      }),
      attach: authorized.terminals.attach.handler(async function* ({ input, context, signal }) {
        try {
          yield* terminals.attach(
            {
              terminalId: input.terminalId,
              ...(input.afterSequence !== undefined && { afterSequence: input.afterSequence }),
              ...(input.mode !== undefined && { mode: input.mode }),
            },
            context.connection.id,
            signal,
          )
        } catch (error) {
          throw apiError(error)
        }
      }),
      write: authorized.terminals.write.handler(({ input, context }) =>
        terminals.write(input, context.connection.id),
      ),
      resize: authorized.terminals.resize.handler(({ input, context }) =>
        terminals.resize(input, context.connection.id),
      ),
      ack: authorized.terminals.ack.handler(({ input, context }) =>
        terminals.ack(input, context.connection.id),
      ),
      close: authorized.terminals.close.handler(({ input, context }) =>
        terminals.close(input, context.connection.id),
      ),
    },
  })
}
