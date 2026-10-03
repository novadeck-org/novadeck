import { homedir } from "node:os"

import { contract, errors as contractErrors, protocolVersion } from "@novadeck/protocol"
import { implement, ORPCError } from "@orpc/server"

import type { CompanionItems } from "./companions/items.js"
import { DomainError } from "./errors.js"
import type { Harnesses } from "./harnesses/service.js"
import type { Terminals } from "./terminals/index.js"
import type { Projects } from "./workspaces/projects.js"
import type { WorkspaceStore } from "./workspaces/store.js"

/** One client of a runner. Its transport decides how the handshake token is checked. */
export type Connection = {
  readonly id: string
  readonly verify: (token: string | undefined) => boolean
  /** Ends the transport, e.g. when a newer connection of the same client takes over. */
  readonly terminate: () => void
  readonly onAuthenticated: () => void
  /** Calls this connection may have in flight; beyond it, calls fail with `RESOURCE_LIMIT`. */
  readonly maxCalls: number
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
  projects: Projects
  items: CompanionItems
  agents: Harnesses
  /** Whether the runner is shutting down. */
  closing: () => boolean
}) => {
  const { store, terminals, projects, items, agents } = options
  const api = implement(contract).$context<Context>()
  const authorized = api.use(async ({ context, next }) => {
    const connection = context.connection
    if (!connection.authenticated || connection.closed) throw new ORPCError("UNAUTHORIZED")
    if (connection.calls >= connection.maxCalls)
      throw new ORPCError("RESOURCE_LIMIT", { status: 429 })
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
        }
      }),
    },
    projects: {
      list: authorized.projects.list.handler(() => projects.list()),
      create: authorized.projects.create.handler(({ input }) =>
        store.createProject({ ...input, cwd: input.cwd ?? homedir() }),
      ),
      rename: authorized.projects.rename.handler(({ input }) => store.renameProject(input)),
      remove: authorized.projects.remove.handler(({ input }) => projects.remove(input.projectId)),
    },
    sessions: {
      list: authorized.sessions.list.handler(({ input }) => store.sessions(input.projectId)),
      create: authorized.sessions.create.handler(({ input }) => {
        projects.ensureNotRemoving(input.projectId)
        return store.createSession(input)
      }),
      rename: authorized.sessions.rename.handler(({ input }) => store.renameSession(input)),
      save: authorized.sessions.save.handler(({ input }) => {
        // Shells exiting during shutdown would otherwise overwrite the last state saved
        // before it with one where nothing runs.
        if (options.closing()) throw new DomainError("RUNTIME_CLOSING")
        store.saveSession(input)
      }),
    },
    terminals: {
      list: authorized.terminals.list.handler(({ input }) => {
        store.session(input.sessionId)
        return terminals.list(input.sessionId)
      }),
      create: authorized.terminals.create.handler(async ({ input, context }) => {
        const session = store.session(input.sessionId)
        const project = store.project(session.projectId)
        return projects.creatingIn(project.id, () =>
          terminals.create({ ...input, cwd: input.cwd ?? project.cwd }, context.connection.id),
        )
      }),
      requests: authorized.terminals.requests.handler(async function* ({ context, signal }) {
        if (context.connection.closed) return
        try {
          yield* terminals.requests(context.connection.id, signal)
        } catch (error) {
          throw apiError(error)
        }
      }),
      answerRequest: authorized.terminals.answerRequest.handler(({ input, context }) =>
        terminals.answerRequest(input, context.connection.id),
      ),
      watch: authorized.terminals.watch.handler(async function* ({ context, signal }) {
        // A connection that closed before this stream began has already been released.
        if (context.connection.closed) return
        try {
          yield* terminals.watch(context.connection.id, signal)
        } catch (error) {
          throw apiError(error)
        }
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
      restart: authorized.terminals.restart.handler(async ({ input, context }) =>
        terminals.restart(input, context.connection.id),
      ),
      close: authorized.terminals.close.handler(({ input, context }) =>
        terminals.close(input, context.connection.id),
      ),
      rename: authorized.terminals.rename.handler(({ input }) => terminals.rename(input)),
      resetTitle: authorized.terminals.resetTitle.handler(({ input }) =>
        terminals.resetTitle(input),
      ),
    },
    agents: {
      list: authorized.agents.list.handler(() => agents.list()),
      detail: authorized.agents.detail.handler(async function* ({ input, context, signal }) {
        if (context.connection.closed) return
        try {
          yield* terminals.detail(input.terminalId, signal)
        } catch (error) {
          throw apiError(error)
        }
      }),
      transcript: authorized.agents.transcript.handler(async function* ({
        input,
        context,
        signal,
      }) {
        if (context.connection.closed) return
        try {
          yield* terminals.transcript(input.terminalId, input.actor, signal)
        } catch (error) {
          throw apiError(error)
        }
      }),
      set: authorized.agents.set.handler(async ({ input }) => {
        const result = await agents.set(input.agent, input.connected)
        if (!result.connected) terminals.forgetAgent(input.agent)
        return result
      }),
    },
    companions: {
      list: authorized.companions.list.handler(({ input }) => {
        store.session(input.sessionId)
        return items.list(input.sessionId)
      }),
      watch: authorized.companions.watch.handler(async function* ({ context, signal }) {
        // A connection that closed before this stream began has already been released.
        if (context.connection.closed) return
        try {
          yield* items.watch(context.connection.id, signal)
        } catch (error) {
          throw apiError(error)
        }
      }),
      content: authorized.companions.content.handler(async function* ({ input, context, signal }) {
        if (context.connection.closed) return
        try {
          yield* items.content(input.itemId, input.reveal === true, signal)
        } catch (error) {
          throw apiError(error)
        }
      }),
      attach: authorized.companions.attach.handler(({ input }) => items.attach(input)),
      move: authorized.companions.move.handler(({ input }) =>
        items.move(input.itemId, input.terminalId),
      ),
      undock: authorized.companions.undock.handler(({ input }) =>
        items.undock(input.itemId, input.windowId),
      ),
      close: authorized.companions.close.handler(({ input }) => items.close(input.itemId)),
      renameWindow: authorized.companions.renameWindow.handler(({ input }) =>
        items.renameWindow(input.windowId, input.title),
      ),
      resetWindowTitle: authorized.companions.resetWindowTitle.handler(({ input }) =>
        items.renameWindow(input.windowId, null),
      ),
    },
    messages: {
      list: authorized.messages.list.handler(({ input }) => terminals.messages(input.terminalId)),
      watch: authorized.messages.watch.handler(async function* ({ input, context, signal }) {
        if (context.connection.closed) return
        try {
          yield* terminals.watchMessages(input.terminalId, signal)
        } catch (error) {
          throw apiError(error)
        }
      }),
      pause: authorized.messages.pause.handler(({ input }) =>
        terminals.pauseMessages(input.paused),
      ),
      release: authorized.messages.release.handler(({ input }) =>
        terminals.releaseThread(input.thread),
      ),
    },
    // The store keeps the settings; the terminals apply the transcript switch.
    settings: {
      get: authorized.settings.get.handler(() => store.settings()),
      set: authorized.settings.set.handler(({ input }) => {
        if (options.closing()) throw new DomainError("RUNTIME_CLOSING")
        store.saveSettings(input)
        if (input.transcripts !== undefined) terminals.keepTranscripts(input.transcripts)
      }),
    },
  })
}
