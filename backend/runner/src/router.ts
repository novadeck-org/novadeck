import { homedir } from "node:os"

import {
  contract,
  errors as contractErrors,
  type AgentName,
  type ItemContent,
} from "@novadeck/protocol"
import { TerminalError } from "@novadeck/terminal"
import type { SessionContext } from "@novadeck/wire/server"
import { implement, ORPCError } from "@orpc/server"

import { savePlan } from "./companions/content.js"
import type { CompanionItems } from "./companions/items.js"
import { DomainError } from "./errors.js"
import type { Harnesses } from "./harnesses/service.js"
import { logs } from "./log.js"
import type { Murmur } from "./murmur/service.js"
import type { Terminals } from "./terminals/index.js"
import type { Uploads } from "./terminals/uploads.js"
import type { Voice } from "./voice/service.js"
import type { Projects } from "./workspaces/projects.js"
import type { WorkspaceStore } from "./workspaces/store.js"

const log = logs.for("router")

// The wire serves its own handshake; the runner serves the rest of the contract.
const { wire: _, ...served } = contract

/** The runner's failures as the contract's errors, which its clients see. */
export const apiError = (error: unknown): unknown => {
  if (error instanceof DomainError)
    return new ORPCError(error.code, {
      status: contractErrors[error.code].status,
      message: error.message,
      data: error.data ?? (error.reason ? { reason: error.reason } : undefined),
    })
  // The terminal library's codes are the contract's own, under the same names.
  if (error instanceof TerminalError)
    return new ORPCError(error.code, {
      status: contractErrors[error.code].status,
      message: error.message,
    })
  return error
}

/**
 * The runner's procedures. Its sessions serve them (`createSessions`): only to authenticated
 * sessions, and mapping their failures with `apiError`.
 */
export const createRouter = (options: {
  store: WorkspaceStore
  terminals: Terminals
  projects: Projects
  items: CompanionItems
  agents: Harnesses
  uploads: Uploads
  voice: Voice
  murmur: Murmur
  /** Whether the runner is shutting down. */
  closing: () => boolean
}) => {
  const { store, terminals, projects, items, agents, uploads, voice, murmur } = options
  // A plan's content says whether Novadeck's plugin is installed into its agent, which the
  // companions can't know: it is looked up as the content leaves.
  const withSkill = async (content: ItemContent, agent: AgentName | undefined) =>
    content.state === "ready" && content.content.kind === "plan" && agent !== undefined
      ? { ...content, content: { ...content.content, skill: await agents.connected(agent) } }
      : content
  // The save of each plan under way, which the next waits for.
  const saving = new Map<string, Promise<void>>()
  const api = implement(served).$context<SessionContext>()

  return api.router({
    projects: {
      list: api.projects.list.handler(() => projects.list()),
      create: api.projects.create.handler(({ input }) =>
        store.createProject({ ...input, cwd: input.cwd ?? homedir() }),
      ),
      rename: api.projects.rename.handler(({ input }) => store.renameProject(input)),
      remove: api.projects.remove.handler(({ input }) => projects.remove(input.projectId)),
    },
    sessions: {
      list: api.sessions.list.handler(({ input }) => store.sessions(input.projectId)),
      create: api.sessions.create.handler(({ input }) => {
        projects.ensureNotRemoving(input.projectId)
        return store.createSession(input)
      }),
      rename: api.sessions.rename.handler(({ input }) => store.renameSession(input)),
      save: api.sessions.save.handler(({ input }) => {
        // Shells exiting during shutdown would otherwise overwrite the last state saved
        // before it with one where nothing runs.
        if (options.closing()) throw new DomainError("CLOSING")
        store.saveSession(input)
      }),
    },
    terminals: {
      list: api.terminals.list.handler(({ input }) => {
        store.session(input.sessionId)
        return terminals.list(input.sessionId)
      }),
      create: api.terminals.create.handler(async ({ input, context }) => {
        const session = store.session(input.sessionId)
        const project = store.project(session.projectId)
        return projects.creatingIn(project.id, () =>
          terminals.create({ ...input, cwd: input.cwd ?? project.cwd }, context.session.id),
        )
      }),
      requests: api.terminals.requests.handler(({ context, signal }) =>
        terminals.requests(context.session.id, signal),
      ),
      answerRequest: api.terminals.answerRequest.handler(({ input, context }) =>
        terminals.answerRequest(input, context.session.id),
      ),
      watch: api.terminals.watch.handler(({ context, signal }) =>
        terminals.watch(context.session.id, signal),
      ),
      attach: api.terminals.attach.handler(({ input, context, signal }) =>
        terminals.attach(
          {
            terminalId: input.terminalId,
            ...(input.afterSequence !== undefined && { afterSequence: input.afterSequence }),
            ...(input.mode !== undefined && { mode: input.mode }),
          },
          context.session.id,
          signal,
        ),
      ),
      write: api.terminals.write.handler(({ input, context }) =>
        terminals.write(input, context.session.id),
      ),
      resize: api.terminals.resize.handler(({ input, context }) =>
        terminals.resize(input, context.session.id),
      ),
      ack: api.terminals.ack.handler(({ input, context }) =>
        terminals.ack(input, context.session.id),
      ),
      upload: api.terminals.upload.handler(async ({ input }) => {
        if (!terminals.place(input.terminalId)) throw new DomainError("TERMINAL_NOT_FOUND")
        return { path: await uploads.save(input) }
      }),
      restart: api.terminals.restart.handler(async ({ input, context }) =>
        terminals.restart(input, context.session.id),
      ),
      close: api.terminals.close.handler(({ input }) => terminals.close(input)),
      rename: api.terminals.rename.handler(({ input }) => terminals.rename(input)),
      resetTitle: api.terminals.resetTitle.handler(({ input }) => terminals.resetTitle(input)),
    },
    agents: {
      list: api.agents.list.handler(() => agents.list()),
      detail: api.agents.detail.handler(({ input, signal }) =>
        terminals.detail(input.terminalId, signal),
      ),
      transcript: api.agents.transcript.handler(({ input, signal }) =>
        terminals.transcript(input.terminalId, input.actor, signal),
      ),
      prompt: api.agents.prompt.handler(({ input }) => terminals.prompt(input)),
      answer: api.agents.answer.handler(({ input }) => terminals.answer(input)),
      interrupt: api.agents.interrupt.handler(({ input }) => terminals.interrupt(input)),
      set: api.agents.set.handler(async ({ input }) => {
        const result = await agents.set(input.agent, input.connected)
        if (!result.connected) terminals.forgetAgent(input.agent)
        return result
      }),
    },
    companions: {
      list: api.companions.list.handler(({ input }) => {
        store.session(input.sessionId)
        return items.list(input.sessionId)
      }),
      watch: api.companions.watch.handler(({ context, signal }) =>
        items.watch(context.session.id, signal),
      ),
      content: api.companions.content.handler(async function* ({ input, signal }) {
        for await (const content of items.content(input.itemId, input.reveal === true, signal))
          yield await withSkill(content, store.item(input.itemId)?.plan?.agent)
      }),
      save: api.companions.save.handler(async ({ input }) => {
        const item = store.item(input.itemId)
        if (!item) throw new DomainError("NOT_FOUND", "Item not found")
        // One save of a plan at a time, each judged by the file the one before left.
        const run = async () => {
          const result = await savePlan(item, input.text, input.basedOn)
          if (result.saved) return result
          const skill = item.plan ? await agents.connected(item.plan.agent) : false
          return { ...result, current: { ...result.current, skill } }
        }
        const answer = (saving.get(item.id) ?? Promise.resolve()).then(run, run)
        const turn = answer.then(
          () => {},
          () => {},
        )
        saving.set(item.id, turn)
        void turn.then(() => {
          if (saving.get(item.id) === turn) saving.delete(item.id)
        })
        try {
          return await answer
        } catch (error) {
          // A plan that can't be written is told to the client; anything else is only seen here.
          if (!(error instanceof DomainError))
            log.error("companions.plan-save-failed", "Novadeck could not save a plan", {
              data: { path: item.path ?? null },
              err: error,
            })
          throw error
        }
      }),
      attach: api.companions.attach.handler(({ input }) => items.attach(input)),
      move: api.companions.move.handler(({ input }) => items.move(input.itemId, input.terminalId)),
      undock: api.companions.undock.handler(({ input }) =>
        items.undock(input.itemId, input.windowId),
      ),
      close: api.companions.close.handler(({ input }) => items.close(input.itemId)),
      renameWindow: api.companions.renameWindow.handler(({ input }) =>
        items.renameWindow(input.windowId, input.title),
      ),
      resetWindowTitle: api.companions.resetWindowTitle.handler(({ input }) =>
        items.renameWindow(input.windowId, null),
      ),
    },
    asks: {
      list: api.asks.list.handler(() => terminals.inboxLetters()),
      watch: api.asks.watch.handler(({ signal }) => terminals.watchAsks(signal)),
      answer: api.asks.answer.handler(({ input }) => terminals.answerAsk(input.id, input.answer)),
      read: api.asks.read.handler(({ input }) => terminals.readTells(input.ids)),
    },
    messages: {
      list: api.messages.list.handler(({ input }) => terminals.messages(input.terminalId)),
      watch: api.messages.watch.handler(({ input, signal }) =>
        terminals.watchMessages(input.terminalId, signal),
      ),
      pause: api.messages.pause.handler(({ input }) => terminals.pauseMessages(input.paused)),
      release: api.messages.release.handler(({ input }) => terminals.releaseThread(input.thread)),
      stop: api.messages.stop.handler(({ input }) => terminals.stopThread(input.thread)),
    },
    voice: {
      watch: api.voice.watch.handler(({ context, signal }) =>
        voice.watch(context.session.id, signal),
      ),
      install: api.voice.install.handler(() => voice.install()),
      cancel: api.voice.cancel.handler(() => voice.cancel()),
      uninstall: api.voice.uninstall.handler(() => voice.uninstall()),
      set: api.voice.set.handler(({ input }) => voice.set(input)),
      record: api.voice.record.handler(({ input, context }) =>
        voice.record(context.session.id, input.clipId, input.offset, input.data),
      ),
      transcribe: api.voice.transcribe.handler(({ input, context }) =>
        voice.transcribe(context.session.id, input.clipId, input.terminalId),
      ),
      discard: api.voice.discard.handler(({ input, context }) =>
        voice.discard(context.session.id, input.clipId),
      ),
    },
    murmur: {
      watch: api.murmur.watch.handler(({ context, signal }) =>
        murmur.watch(context.session.id, signal),
      ),
      install: api.murmur.install.handler(() => murmur.install()),
      cancel: api.murmur.cancel.handler(() => murmur.cancel()),
      uninstall: api.murmur.uninstall.handler(() => murmur.uninstall()),
      set: api.murmur.set.handler(({ input }) => murmur.set(input)),
      noteOffered: api.murmur.noteOffered.handler(() => murmur.noteOffered()),
      gist: api.murmur.gist.handler(({ input }) =>
        terminals.gistWanted(input.terminalId, input.at),
      ),
    },
    // The store keeps the settings; the terminals apply the transcript switch.
    settings: {
      get: api.settings.get.handler(() => store.settings()),
      set: api.settings.set.handler(({ input }) => {
        if (options.closing()) throw new DomainError("CLOSING")
        store.saveSettings(input)
        if (input.transcripts !== undefined) terminals.keepTranscripts(input.transcripts)
      }),
    },
  })
}
