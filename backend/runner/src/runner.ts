import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { errors, protocolVersion } from "@novadeck/protocol"
import { TerminalError } from "@novadeck/terminal"
import { userScopes } from "@novadeck/terminal/pty"
import { createSessions, type Sessions } from "@novadeck/wire/server"
import { ORPCError } from "@orpc/server"

import { CompanionItems } from "./companions/items.js"
import { DomainError } from "./errors.js"
import { createHarnesses, type HarnessesOptions } from "./harnesses/service.js"
import { logs } from "./log.js"
import { Murmur } from "./murmur/service.js"
import { apiError, createRouter } from "./router.js"
import { installShellFiles } from "./shell/install.js"
import { Terminals, type TerminalOptions } from "./terminals/index.js"
import { createTranscriptSealer, transcriptsAvailable } from "./terminals/sealing.js"
import { Uploads } from "./terminals/uploads.js"
import { Voice } from "./voice/service.js"
import { Projects } from "./workspaces/projects.js"
import {
  EarlierWorkspaceError,
  setAsideWorkspace,
  WorkspaceStore,
  WorkspaceTooNewError,
} from "./workspaces/store.js"

const log = logs.for("runner")

export type RunnerOptions = {
  /** SQLite file for project and session metadata; in memory when omitted. */
  database?: string
  /**
   * The 32-byte key saved transcripts are encrypted with, or null where none can be kept
   * safe, as the desktop app's main process unwraps it from the system's keychain. Without
   * one no transcript is saved or shown again.
   */
  transcriptKey?: Promise<Uint8Array | null>
  /** Terminal limits; the number of terminals is unlimited unless `maxTerminals` is set. */
  terminals?: TerminalOptions
  /**
   * Where the shell integration, hook and agent plugins are written, such as a `shell`
   * folder beside the database. Without it shells start without the integration.
   */
  shell?: string
  /**
   * Where files pasted into terminals are saved, such as an `uploads` folder beside the
   * database; a fresh temporary folder when omitted.
   */
  uploads?: string
  /**
   * The relay agents start for Novadeck's MCP server and hooks, copied in beside the shell files;
   * the one `@novadeck/relay` built by default. The desktop app passes the one it ships.
   */
  relay?: string
  /**
   * Voice input's speech engine: `engine` is the path to its manifest (`engine.json`),
   * `source` where its archive is, an https URL ending in `/` or a folder, and `directory`
   * where it and the models install, a `voice` folder beside the database by default.
   * Without an engine voice input is unavailable.
   */
  voice?: {
    readonly engine?: string
    readonly source?: string
    readonly directory?: string
  }
  /**
   * Murmur's engine, which writes terminals' titles: `engine` is the path to
   * its manifest (`engine.json`), `source` where its archive is, an https URL ending in `/`
   * or a folder, and `directory` where it and the model install, a `murmur` folder beside
   * the database by default. Without an engine murmur is unavailable and nothing is described.
   */
  murmur?: {
    readonly engine?: string
    readonly source?: string
    readonly directory?: string
  }
  /**
   * The app saw only software rendering: murmur is not available on this computer, and
   * voice input installs its small model without trying turbo.
   */
  softwareGraphics?: boolean
  /** Where agents are looked for and how their plugin commands run; for tests. */
  agents?: HarnessesOptions
}

export type Runner = {
  /**
   * Its clients' sessions, for a transport to serve (`serveWebSocket`, `servePort`). Their
   * epoch is this runner's lifetime: terminal cursors are only valid within it. A session
   * that ends releases its attachments and terminal control; its shells keep running.
   */
  readonly sessions: Sessions
  /** The largest initial snapshot, which transports allow for in their send buffers. */
  readonly snapshotBytes: number
  /** Saves every terminal's restore state now, as when the system is shutting down. */
  persist(): void
  /**
   * Saves every terminal, then refuses further saves of sessions and terminals, ends
   * every shell and closes the metadata store.
   */
  close(): Promise<void>
}

/**
 * The workspace store at `database`, carried forward from an earlier build's in place. One
 * it can't carry (older than the first migration, whose step doesn't fit it, or whose
 * tables differ from its version's) is set aside and a new one started, so an update never
 * leaves the runner unable to start; the old file stays beside it.
 */
const openStore = (database: string | undefined): WorkspaceStore => {
  try {
    return new WorkspaceStore(database)
  } catch (error) {
    if (!(error instanceof EarlierWorkspaceError) || database === undefined) throw error
    const aside = setAsideWorkspace(database)
    log.warn(
      "workspace.set-aside",
      `${error.message} It was set aside as ${aside}, and a new one started.`,
    )
    return new WorkspaceStore(database)
  }
}

/**
 * The runner's parts, wired together: its metadata store, the shell files it writes once,
 * the agents that install Novadeck's plugin, the terminals, which keep their records and
 * messages in the store, and the items shown beside them. `createRunner` serves them; the end-to-end deck drives them
 * in process, so both run the same wiring. Internal: not exported from the package.
 */
export const wire = (options: RunnerOptions) => {
  const store = openStore(options.database)
  // Written once, for the shells and for the agents that install Novadeck's plugin.
  const shellFiles =
    options.shell === undefined
      ? Promise.resolve(undefined)
      : installShellFiles(
          options.shell,
          options.relay === undefined ? {} : { relay: options.relay },
        ).catch((error: unknown) => {
          log.error("shell.integration-unavailable", "Novadeck shell integration is unavailable", {
            err: error,
          })
          return undefined
        })
  // The runner's own calls of the relay use the build's, never the copy for agents.
  const relay = options.relay === undefined ? {} : { relay: options.relay }
  const agents = createHarnesses(() => shellFiles, { ...relay, ...options.agents })
  // A connected agent that keeps its own copy of the plugin gets the files just written,
  // where they differ from that copy (see `Harness.installed`).
  void shellFiles
    .then((written) => (written ? agents.refresh() : []))
    .catch((error: unknown) =>
      log.error("harnesses.refresh-failed", "Novadeck could not refresh its plugins", {
        err: error,
      }),
    )
  // What agents show and the person attaches beside terminals, kept in the store; it
  // asks the terminals where each one is.
  const items = new CompanionItems({
    records: store,
    terminal: (terminalId) => terminals.place(terminalId),
    project: (sessionId) => {
      try {
        return store.project(store.session(sessionId).projectId).cwd
      } catch (error) {
        // Only a session or project gone from the store is no folder to show from.
        if (error instanceof DomainError && error.code === "NOT_FOUND") return undefined
        throw error
      }
    },
    livePlan: (item) => terminals.livePlan(item),
  })
  const voice = new Voice(store.settings, {
    ...(options.softwareGraphics !== undefined && { softwareGraphics: options.softwareGraphics }),
    engine: options.voice?.engine,
    source: options.voice?.source,
    directory:
      options.voice?.directory ??
      (options.database === undefined
        ? join(tmpdir(), `novadeck-voice-${randomUUID()}`)
        : join(dirname(options.database), "voice")),
    // A terminal's facts, with its project's name, for the hint of a clip dictated into it;
    // a project gone from the store takes only its name from the hint.
    hint: async (terminalId) => {
      const place = terminals.place(terminalId)
      const facts = await terminals.hintFacts(terminalId)
      if (!place || !facts) return undefined
      let project: string | null = null
      try {
        project = store.project(store.session(place.sessionId).projectId).name
      } catch {
        // Gone, as when the project closed while the clip was recorded.
      }
      return { ...facts, project }
    },
  })
  // Not awaited: the runner starts at once, and the first voice call waits for the load.
  voice.start()
  const murmur = new Murmur(store.settings, {
    engine: options.murmur?.engine,
    source: options.murmur?.source,
    directory:
      options.murmur?.directory ??
      (options.database === undefined
        ? join(tmpdir(), `novadeck-murmur-${randomUUID()}`)
        : join(dirname(options.database), "murmur")),
    ...(options.softwareGraphics !== undefined && { softwareGraphics: options.softwareGraphics }),
    // Voice input has priority over the GPU.
    voice: voice.activity,
  })
  murmur.start()
  // On Linux each shell runs in a systemd scope of its own, so one killed for memory
  // takes down its terminal, not the app.
  const scopes = userScopes()
  // Without a key from the app no transcript is saved or shown.
  const sealer = createTranscriptSealer(options.transcriptKey)
  const terminals = new Terminals({
    records: store,
    sealer,
    shellFiles,
    ...relay,
    // Codex runs through Novadeck's shim while it is connected; see `posixCodexShim`.
    shims: () => agents.shims(),
    connected: (agent) => agents.connected(agent),
    // Where each harness lives, which says how it may start with a task.
    install: (agent) => agents.install(agent),
    models: (agent) => agents.models(agent),
    transcripts: store.settings.runner().transcripts,
    projectFolder: (sessionId) => store.project(store.session(sessionId).projectId).cwd,
    // Agents message each other within a project, and their messages are kept with it.
    messages: store,
    inbox: store,
    projectOf: (sessionId) => store.session(sessionId).projectId,
    items,
    // Without an engine nothing is described, so terminals have nothing to wait for.
    ...(options.murmur?.engine !== undefined && { describer: murmur }),
    ...(scopes && { pty: { scopes } }),
    ...options.terminals,
  })
  const projects = new Projects(store, terminals, items)
  const uploads = new Uploads(options.uploads)
  return { store, shellFiles, agents, terminals, items, projects, uploads, voice, murmur, sealer }
}

/**
 * What stands in for a runner whose workspace a newer Novadeck wrote: it owns nothing, and
 * tells every client that proves itself why (`WORKSPACE_TOO_NEW`).
 */
const refusingRunner = (): Runner => ({
  // A client that proves itself is told why, and nothing else is served. The runner stays
  // up, so a client that retries is told again instead of finding a process that crashed.
  sessions: createSessions({
    protocolVersion,
    router: {},
    admit: () => {
      throw new ORPCError("WORKSPACE_TOO_NEW", { status: errors.WORKSPACE_TOO_NEW.status })
    },
  }),
  snapshotBytes: 0,
  persist: () => {},
  close: () => Promise.resolve(),
})

/**
 * Owns shells and workspace metadata, independent of how clients reach it. Over a workspace
 * database a newer runner wrote, it refuses every client instead (see `refusingRunner`).
 */
export const createRunner = (options: RunnerOptions = {}): Runner => {
  try {
    return startRunner(options)
  } catch (error) {
    if (error instanceof WorkspaceTooNewError) {
      log.error("workspace.too-new", "A newer Novadeck wrote the workspace database", {
        err: error,
      })
      return refusingRunner()
    }
    throw error
  }
}

/**
 * Logs a failure a client was answered with: one the contract names, by its code alone, as
 * the client is told, at info, as a page asking for what just went is routine; any other,
 * which the client sees as an internal error, as an error with its stack.
 */
const logFailure = (path: readonly string[], error: unknown): void => {
  const code: unknown = (error as { code?: unknown } | undefined)?.code
  const procedure = path.join(".")
  if (error instanceof DomainError || error instanceof TerminalError || error instanceof ORPCError)
    log.info("rpc.failed", "A call failed as the contract says.", {
      data: { path: procedure, code: typeof code === "string" ? code : null },
    })
  else
    log.error("rpc.failed", "A call failed unexpectedly.", {
      data: { path: procedure, code: null },
      err: error,
    })
}

const startRunner = (options: RunnerOptions): Runner => {
  const { store, terminals, items, agents, projects, uploads, voice, murmur, sealer } =
    wire(options)
  let closing: Promise<void> | undefined
  return {
    sessions: createSessions({
      protocolVersion,
      router: createRouter({
        store,
        terminals,
        feedback: terminals.feedback,
        projects,
        items,
        agents,
        uploads,
        voice,
        murmur,
        transcriptsAvailable: () => transcriptsAvailable(sealer),
        closing: () => closing !== undefined,
      }),
      error: apiError,
      failed: logFailure,
      admit: (session) =>
        log.info("client.connected", "A client connected.", { data: { session: session.id } }),
      // Whatever a client held through a session it lost or replaced: its shells keep running.
      closed: (session) => {
        log.info("client.closed", "A client's session ended.", { data: { session: session.id } })
        terminals.release(session.id)
        voice.release(session.id)
        murmur.release(session.id)
      },
    }),
    snapshotBytes: options.terminals?.snapshotBytes ?? 32 * 1024 * 1024,
    persist: () => {
      if (!closing) terminals.persist()
    },
    close() {
      closing ??= (async () => {
        try {
          await terminals.shutdown()
        } finally {
          // Downloads and the engine use no records, but end before the store they ask;
          // the store closes even if they fail to.
          try {
            await voice.close()
          } finally {
            try {
              await murmur.close()
            } finally {
              store.close()
            }
          }
        }
      })()
      return closing
    },
  }
}
