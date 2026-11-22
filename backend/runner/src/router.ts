import { homedir } from "node:os"

import {
  contract,
  errors as contractErrors,
  type AgentName,
  type HistoryChange,
  type WorkChange,
  type WorkMade,
  type ItemContent,
  maxClientStateLength,
} from "@novadeck/protocol"
import { TerminalError } from "@novadeck/terminal"
import { dropUnknownKeys, type SessionContext } from "@novadeck/wire/server"
import { implement, ORPCError } from "@orpc/server"

import { savePlan } from "./companions/content.js"
import type { CompanionItems } from "./companions/items.js"
import { planSaveFolders } from "./companions/plan-folders.js"
import { DomainError } from "./errors.js"
import type { Forges } from "./forges/service.js"
import type { Harnesses } from "./harnesses/service.js"
import type { History } from "./history.js"
import { logs } from "./log.js"
import type { Feedback } from "./messaging/feedback.js"
import type { Murmur } from "./murmur/service.js"
import type { ActiveTerminals } from "./terminals/active.js"
import type { ClientWindows } from "./terminals/client-windows.js"
import type { Terminals } from "./terminals/index.js"
import type { SeenTerminals } from "./terminals/seen.js"
import type { Uploads } from "./terminals/uploads.js"
import type { Tour } from "./tour/tour.js"
import type { Voice } from "./voice/service.js"
import type { Works } from "./works/works.js"
import { listFolder } from "./workspaces/folder.js"
import type { Projects } from "./workspaces/projects.js"
import type { WorkspaceStore } from "./workspaces/store.js"
import type { MainCheckouts } from "./worktrees/main-checkout.js"

const log = logs.for("router")

// Each unknown key told of once per procedure: a newer client sends it on every call.
const told = new Set<string>()

// The wire serves its own handshake; the runner serves the rest of the contract. A newer UI
// may send a field this runner doesn't know: it is dropped before the handler runs, so the
// field must be one an older runner may ignore (docs/backend-api.md, "Versions"). The
// contract's own schemas, which the runner also parses agents' tool arguments with, stay strict.
const { wire: _, ...contracted } = contract
const served = dropUnknownKeys(contracted, (procedure, keys) => {
  const path = procedure.join(".")
  const fresh = keys.filter((key) => !told.has(`${path}:${key}`))
  if (fresh.length === 0) return
  for (const key of fresh) told.add(`${path}:${key}`)
  log.info("rpc.dropped", "A client sent fields this runner doesn't know; they were dropped.", {
    data: { path, keys: fresh.join(",") },
  })
})

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

// What `history.watch` reports without a History: nothing is kept, and the stream waits.
const noHistory = {
  list: (_projectId: string) => [],
  watch: (_sessionId: string, signal?: AbortSignal) => noHistoryStream(signal),
}

const noHistoryStream = async function* (signal?: AbortSignal): AsyncGenerator<HistoryChange> {
  yield { type: "synced" }
  if (signal?.aborted) return
  await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()))
}

const noWorksStream = async function* (signal?: AbortSignal): AsyncGenerator<WorkChange> {
  yield { type: "synced" }
  if (signal?.aborted) return
  await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()))
}

const noWorksMade = async function* (signal?: AbortSignal): AsyncGenerator<WorkMade> {
  if (signal?.aborted) return
  await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()))
  yield* [] as WorkMade[]
}

// What the forges report without them: none is offered, and none can be switched on.
const noForges = {
  list: () => Promise.resolve([]),
  set: () => Promise.reject(new DomainError("NOT_FOUND", "No forge is offered.")),
}

// What `works.watch` reports without Works: nothing, and the stream waits.
const noWorks = {
  watch: (_ownerId: string, signal?: AbortSignal) => noWorksStream(signal),
  made: (_ownerId: string, signal?: AbortSignal) => noWorksMade(signal),
  look: () => Promise.reject(new DomainError("NOT_FOUND")),
  show: () => Promise.reject(new DomainError("NOT_FOUND")),
  closeWork: () => Promise.reject(new DomainError("NOT_FOUND")),
  preview: () => Promise.resolve({ main: null, works: [], renames: [] }),
  fetch: () => Promise.resolve(),
}

// What the Files panel's checkout state is without a worktrees service: nothing to say or move.
const noCheckouts = {
  read: () => Promise.resolve({ behind: null, moved: 0, head: null }),
  update: () => Promise.resolve({ ok: false as const, said: "There is nothing to update." }),
}

const noTour: Pick<Tour, "prepare" | "brief" | "nudge" | "artist" | "keep"> = {
  prepare: () => Promise.reject(new DomainError("CONFLICT", "No tour is offered.")),
  brief: () => {
    throw new DomainError("CONFLICT", "No tour is offered.")
  },
  nudge: () => {
    throw new DomainError("CONFLICT", "No tour is offered.")
  },
  artist: () => {
    throw new DomainError("CONFLICT", "No tour is offered.")
  },
  keep: () => Promise.reject(new DomainError("CONFLICT", "No tour is offered.")),
}

/**
 * The runner's procedures. Its sessions serve them (`createSessions`): only to authenticated
 * sessions, and mapping their failures with `apiError`.
 */
export const createRouter = (options: {
  store: WorkspaceStore
  terminals: Terminals
  feedback: Feedback
  projects: Projects
  items: CompanionItems
  /** Closed terminals; without it History is empty. */
  history?: History
  /** Each terminal's work against main; without it the Worktrees panel is empty. */
  works?: Works
  /** The projects' own checkouts against their remote's main. */
  checkouts?: Pick<MainCheckouts, "read" | "update">
  agents: Harnesses
  /** The forges pull requests come from; without it none is offered. */
  forges?: Forges
  uploads: Uploads
  voice: Voice
  murmur: Murmur
  /** Whether transcripts can be kept: not once it is known there is no key to seal them with. */
  transcriptsAvailable: () => Promise<boolean>
  /** Whether the runner is shutting down. */
  closing: () => boolean
  /** Which terminals the people at the clients use; without it, reports of them are ignored. */
  activity?: Pick<ActiveTerminals, "report">
  /** Which project each client shows; without it, reports of it are ignored. */
  clients?: Pick<ClientWindows, "report" | "touch">
  /** Which terminals the clients have in sight; without it, reports of them are ignored. */
  seen?: Pick<SeenTerminals, "report">
  /** The runner settings were saved. */
  settingsSaved?: () => void
  /** The shipping gate was switched on or off by a settings change. */
  shippingSwitched?: () => void
  /** Novadeck's tour; without it, starting one is a CONFLICT. */
  tour?: Tour
}) => {
  const { store, terminals, feedback, projects, items, agents, uploads, voice, murmur } = options
  const history = options.history ?? noHistory
  const works = options.works ?? noWorks
  const checkouts = options.checkouts ?? noCheckouts
  const forges = options.forges ?? noForges
  const tour: Pick<Tour, "prepare" | "brief" | "nudge" | "artist" | "keep"> = options.tour ?? noTour
  // A plan's content says whether Novadeck's plugin is installed into its agent, which the
  // companions can't know: it is looked up as the content leaves.
  const withSkill = async (content: ItemContent, agent: AgentName | undefined) =>
    content.state === "ready" && content.content.kind === "plan" && agent !== undefined
      ? { ...content, content: { ...content.content, skill: await agents.connected(agent) } }
      : content
  // The save of each plan under way, which the next waits for.
  const saving = new Map<string, Promise<void>>()
  const api = implement(served).$context<SessionContext>()
  // The projects' and sessions' changes, for clients that share them.
  const { projectFeed, sessionFeed } = projects

  return api.router({
    projects: {
      list: api.projects.list.handler(() => projects.list()),
      create: api.projects.create.handler(async ({ input }) => {
        const made = await store.createProject({ ...input, cwd: input.cwd ?? homedir() })
        projectFeed.changed()
        return made
      }),
      rename: api.projects.rename.handler(({ input }) => {
        const renamed = store.renameProject(input)
        projectFeed.changed()
        return renamed
      }),
      arrange: api.projects.arrange.handler(({ input }) =>
        projects.arrange(input.order, input.pinned),
      ),
      remove: api.projects.remove.handler(({ input }) => projects.remove(input.projectId)),
      folder: api.projects.folder.handler(({ input }) => {
        projects.ensureNotRemoving(input.projectId)
        return listFolder(store.project(input.projectId).cwd, input.folder)
      }),
      watch: api.projects.watch.handler(({ signal }) =>
        projectFeed.watch(signal ?? new AbortController().signal),
      ),
      checkout: api.projects.checkout.handler(({ input }) =>
        checkouts.read(store.project(input.projectId).cwd),
      ),
      updateCheckout: api.projects.updateCheckout.handler(({ input }) =>
        checkouts.update(store.project(input.projectId).cwd),
      ),
    },
    sessions: {
      list: api.sessions.list.handler(({ input }) => projects.sessions(input.projectId)),
      create: api.sessions.create.handler(({ input }) => {
        projects.ensureNotRemoving(input.projectId)
        const made = store.createSession(input)
        sessionFeed.changed(made.id)
        return made
      }),
      rename: api.sessions.rename.handler(({ input }) => {
        const renamed = store.renameSession(input)
        sessionFeed.changed(renamed.id)
        return renamed
      }),
      arrange: api.sessions.arrange.handler(({ input }) => {
        projects.arrangeSessions(input.projectId, input.order)
      }),
      remove: api.sessions.remove.handler(async ({ input }) => {
        await projects.removeSession(input.sessionId)
      }),
      save: api.sessions.save.handler(({ input }) => {
        // Shells exiting during shutdown would otherwise overwrite the last state saved
        // before it with one where nothing runs.
        if (options.closing()) throw new DomainError("CLOSING")
        store.saveSession(input)
        sessionFeed.changed(input.sessionId)
      }),
      change: api.sessions.change.handler(({ input }) => {
        if (options.closing()) throw new DomainError("CLOSING")
        const revision = store.changeSession({
          sessionId: input.sessionId,
          patch: input.patch,
          visitedAt: input.visitedAt,
          maxLength: maxClientStateLength,
        })
        sessionFeed.changed(input.sessionId, { writer: input.writer, base: input.base })
        return { revision }
      }),
      watch: api.sessions.watch.handler(({ signal }) =>
        sessionFeed.watch(signal ?? new AbortController().signal),
      ),
    },
    terminals: {
      list: api.terminals.list.handler(({ input }) => {
        store.session(input.sessionId)
        return terminals.list(input.sessionId)
      }),
      create: api.terminals.create.handler(async ({ input, context }) => {
        const session = store.session(input.sessionId)
        const project = store.project(session.projectId)
        return projects.creatingIn(project.id, session.id, () =>
          terminals.create({ ...input, cwd: input.cwd ?? project.cwd }, context.session.id),
        )
      }),
      requests: api.terminals.requests.handler(({ context, signal }) =>
        terminals.requests(context.session.id, signal),
      ),
      answerRequest: api.terminals.answerRequest.handler(({ input, context }) =>
        terminals.answerRequest(input, context.session.id),
      ),
      approvals: api.terminals.approvals.handler(({ context, signal }) =>
        terminals.approvals(context.session.id, signal),
      ),
      answerApproval: api.terminals.answerApproval.handler(({ input, context }) =>
        terminals.answerApproval(input, context.session.id),
      ),
      release: api.terminals.release.handler(({ input }) =>
        terminals.releaseLead(input.terminalId),
      ),
      busy: api.terminals.busy.handler(({ input }) => terminals.busyShells(input?.fresh === true)),
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
      active: api.terminals.active.handler(({ input, context }) => {
        options.clients?.touch(context.session.id)
        options.activity?.report(context.session.id, input.terminalId)
      }),
      showing: api.terminals.showing.handler(({ input, context }) =>
        options.clients?.report(context.session.id, input.projectId),
      ),
      seen: api.terminals.seen.handler(({ input, context }) =>
        options.seen?.report(context.session.id, input.terminalIds),
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
      move: api.terminals.move.handler(({ input }) => projects.moveTerminal(input)),
      close: api.terminals.close.handler(({ input }) => terminals.close(input)),
      rename: api.terminals.rename.handler(({ input }) => terminals.rename(input)),
      resetTitle: api.terminals.resetTitle.handler(({ input }) => terminals.resetTitle(input)),
    },
    agents: {
      list: api.agents.list.handler(({ input }) => agents.list(input)),
      detail: api.agents.detail.handler(({ input, signal }) =>
        terminals.detail(input.terminalId, signal),
      ),
      slice: api.agents.slice.handler(({ input, signal }) =>
        terminals.slice(input.terminalId, signal, input.screen),
      ),
      transcript: api.agents.transcript.handler(({ input, signal }) =>
        terminals.transcript(input.terminalId, input.actor, signal),
      ),
      transcriptImage: api.agents.transcriptImage.handler(({ input }) =>
        terminals.transcriptImage(input.terminalId, input),
      ),
      prompt: api.agents.prompt.handler(async ({ input }) => {
        // Only images this runner saved are pasted into an agent's box.
        if (!input.images) return terminals.prompt(input)
        const images = await uploads.checkImages(input.images)
        return terminals.prompt({ ...input, images, files: input.images })
      }),
      keys: api.agents.keys.handler(({ input }) => terminals.keys(input)),
      takeBox: api.agents.takeBox.handler(({ input }) => terminals.takeBox(input.terminalId)),
      putBox: api.agents.putBox.handler(({ input }) => terminals.putBox(input)),
      clearBox: api.agents.clearBox.handler(({ input }) => terminals.clearBox(input)),
      answer: api.agents.answer.handler(({ input, context }) =>
        terminals.answer(input, context.session.id),
      ),
      saveDialog: api.agents.saveDialog.handler(({ input }) => terminals.saveDialog(input)),
      interrupt: api.agents.interrupt.handler(({ input }) => terminals.interrupt(input)),
      set: api.agents.set.handler(async ({ input }) => {
        const result = await agents.set(input.agent, input.connected)
        if (!result.connected) terminals.forgetAgent(input.agent)
        return result
      }),
    },
    forges: {
      list: api.forges.list.handler(({ input }) => forges.list(input)),
      set: api.forges.set.handler(({ input }) => forges.set(input.forge, input.enabled)),
    },
    history: {
      list: api.history.list.handler(({ input }) => history.list(input.projectId)),
      watch: api.history.watch.handler(({ context, signal }) =>
        history.watch(context.session.id, signal),
      ),
    },
    works: {
      watch: api.works.watch.handler(({ context, signal }) =>
        works.watch(context.session.id, signal),
      ),
      made: api.works.made.handler(({ context, signal }) => works.made(context.session.id, signal)),
      look: api.works.look.handler(({ input }) => works.look(input.root)),
      show: api.works.show.handler(({ input }) => works.show(input.root, input.terminalId)),
      preview: api.works.preview.handler(({ input }) => works.preview(input.projectId, input.path)),
      close: api.works.close.handler(({ input }) =>
        works.closeWork(input.root, input.force === true),
      ),
      fetch: api.works.fetch.handler(({ input }) => works.fetch(input.projectId)),
    },
    companions: {
      list: api.companions.list.handler(({ input }) => {
        store.session(input.sessionId)
        return items.list(input.sessionId)
      }),
      watch: api.companions.watch.handler(({ context, signal }) =>
        items.watch(context.session.id, signal),
      ),
      looks: api.companions.looks.handler(({ context, signal }) =>
        items.followLooks(context.session.id, signal),
      ),
      answerLook: api.companions.answerLook.handler(({ input, context }) =>
        items.answerLook(input, context.session.id),
      ),
      content: api.companions.content.handler(async function* ({ input, signal }) {
        for await (const content of items.content(input.itemId, input.reveal, signal, input.within))
          yield await withSkill(content, store.item(input.itemId)?.plan?.agent)
      }),
      changeFile: api.companions.changeFile.handler(({ input }) => items.changeFile(input)),
      changeRange: api.companions.changeRange.handler(({ input }) => items.changeRange(input)),
      changeRead: api.companions.changeRead.handler(({ input }) => items.changeRead(input)),
      part: api.companions.part.handler(({ input }) => items.part(input)),
      save: api.companions.save.handler(async ({ input }) => {
        const item = store.item(input.itemId)
        if (!item) throw new DomainError("NOT_FOUND", "Item not found")
        // One save of a plan at a time, each judged by the file the one before left.
        const run = async () => {
          const folders = await planSaveFolders(item, {
            projectFolder: (sessionId) => store.project(store.session(sessionId).projectId).cwd,
            place: (terminalId) => terminals.place(terminalId),
            planFolders: (agent) => agents.planFolders(agent),
          })
          const result = await savePlan(item, input.text, input.basedOn, folders)
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
      folders: api.companions.folders.handler(({ input }) => items.folders(input)),
      wroteTo: api.companions.wroteTo.handler(({ input }) => items.wroteTo(input)),
      repoint: api.companions.repoint.handler(({ input }) => items.repoint(input)),
      openInProject: api.companions.openInProject.handler(({ input }) =>
        items.openInProject(input),
      ),
      move: api.companions.move.handler(({ input }) => items.move(input.itemId, input.terminalId)),
      undock: api.companions.undock.handler(({ input }) =>
        items.undock(input.itemId, input.windowId),
      ),
      close: api.companions.close.handler(({ input }) => items.close(input.itemId)),
      pageTrouble: api.companions.pageTrouble.handler(({ input }) => items.pageTrouble(input)),
      renameWindow: api.companions.renameWindow.handler(({ input }) =>
        items.renameWindow(input.windowId, input.title),
      ),
      resetWindowTitle: api.companions.resetWindowTitle.handler(({ input }) =>
        items.renameWindow(input.windowId, null),
      ),
    },
    inbox: {
      list: api.inbox.list.handler(() => terminals.inboxEntries()),
      watch: api.inbox.watch.handler(({ signal }) => terminals.watchInbox(signal)),
      answer: api.inbox.answer.handler(({ input }) => terminals.answerAsk(input.id, input.answer)),
      answerQuestions: api.inbox.answerQuestions.handler(({ input }) =>
        terminals.answerAsk(input.id, { type: "questions", answers: input.answers }),
      ),
      read: api.inbox.read.handler(({ input }) => terminals.readTells(input.ids)),
      dismiss: api.inbox.dismiss.handler(({ input }) => terminals.dismissAsk(input.id)),
    },
    feedback: {
      watch: api.feedback.watch.handler(({ signal }) => feedback.watch(signal)),
      settle: api.feedback.settle.handler(({ input }) => feedback.settle(input.id)),
      ask: api.feedback.ask.handler(({ input }) => feedback.ask(input.terminalId, input.hint)),
    },
    messages: {
      list: api.messages.list.handler(({ input }) => terminals.messages(input.terminalId)),
      rings: api.messages.rings.handler(({ input }) =>
        terminals.rings(input.terminalId, input.since),
      ),
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
    },
    // The store keeps the settings; the terminals apply the transcript switch.
    settings: {
      get: api.settings.get.handler(async () => ({
        ...store.settings.runner(),
        transcriptsAvailable: await options.transcriptsAvailable(),
      })),
      set: api.settings.set.handler(({ input }) => {
        if (options.closing()) throw new DomainError("CLOSING")
        store.settings.saveRunner(input)
        options.settingsSaved?.()
        if (input.shippingGate !== undefined) options.shippingSwitched?.()
        if (input.transcripts !== undefined) terminals.keepTranscripts(input.transcripts)
      }),
    },
    tour: {
      prepare: api.tour.prepare.handler(({ input }) => tour.prepare(input.agent)),
      brief: api.tour.brief.handler(({ input }) => tour.brief(input.terminalId)),
      nudge: api.tour.nudge.handler(({ input }) => tour.nudge(input.terminalId)),
      artist: api.tour.artist.handler(({ input }) => tour.artist(input.terminalId)),
      keep: api.tour.keep.handler(() => tour.keep()),
    },
  })
}
