import { randomUUID } from "node:crypto"
import { readdirSync, unwatchFile, watchFile } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { compatibility, errors, forgeName } from "@novadeck/protocol"
import { relayPath } from "@novadeck/relay"
import { TerminalError } from "@novadeck/terminal"
import { taggedScopes, terminalPriorities, userScopes, windowsJobs } from "@novadeck/terminal/pty"
import { TourError } from "@novadeck/tour-runner/errors"
import { TourRecords } from "@novadeck/tour-runner/records"
import type { TourAssets } from "@novadeck/tour-runner/seed"
import { Tour } from "@novadeck/tour-runner/tour"
import { createSessions, type Sessions, type Verdict } from "@novadeck/wire/server"
import { ORPCError } from "@orpc/server"

import { git } from "./checkouts/git.js"
import { Snapshots } from "./checkouts/snapshots.js"
import { CompanionItems } from "./companions/items.js"
import { secrets } from "./companions/secrets.js"
import { Devices } from "./devices/devices.js"
import { DomainError } from "./errors.js"
import { repositoriesOf } from "./forges/repositories.js"
import { Forges } from "./forges/service.js"
import { BundledPi } from "./harnesses/bundled-pi.js"
import { createHarnesses, type HarnessesOptions } from "./harnesses/service.js"
import { logs } from "./log.js"
import { Murmur } from "./murmur/service.js"
import { findProgram } from "./programs.js"
import { apiError, createRouter } from "./router.js"
import { codexConfig, installShellFiles } from "./shell/install.js"
import { Shipping } from "./shipping/service.js"
import { ActiveTerminals } from "./terminals/active.js"
import { ClientWindows } from "./terminals/client-windows.js"
import { Terminals, type TerminalOptions } from "./terminals/index.js"
import { createTranscriptSealer, transcriptsAvailable } from "./terminals/sealing.js"
import { SeenTerminals } from "./terminals/seen.js"
import { Uploads } from "./terminals/uploads.js"
import { watchWorking } from "./terminals/working.js"
import { Voice } from "./voice/service.js"
import { Works } from "./works/works.js"
import { Projects } from "./workspaces/projects.js"
import { effectiveAgentMode } from "./workspaces/settings.js"
import {
  EarlierWorkspaceError,
  setAsideWorkspace,
  WorkspaceStore,
  WorkspaceTooNewError,
} from "./workspaces/store.js"
import { keepWorktreeChanges } from "./worktrees/changes-shown.js"
import { MainCheckouts } from "./worktrees/main-checkout.js"
import { repositoryKnown } from "./worktrees/repo.js"
import { RootFolder } from "./worktrees/root-folder.js"
import { Worktrees } from "./worktrees/worktrees.js"

const log = logs.for("runner")

// The owner `RunnerOptions.working`'s watch of the terminals is under: no client's session,
// so none releases it; it ends as the runner closes.
const workingWatcher = "runner:working"

// Whether a folder holds anything: no folder, or one that can't be read, holds nothing.
const hasContents = (folder: string): boolean => {
  try {
    return readdirSync(folder).length > 0
  } catch {
    return false
  }
}

export type RunnerOptions = {
  /** SQLite file for project and session metadata; in memory when omitted. */
  database?: string
  /**
   * The 32-byte key saved transcripts are encrypted with, or null where none can be kept
   * safe, as the desktop app's main process unwraps it from the system's keychain and a
   * standalone runner reads its key file (`loadTranscriptKeyFile`). Without
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
   * Where agents' worktrees live, which the harness shims pass on as `--add-dir` while it
   * exists; `~/.novadeck/worktrees` of the runner's own home when omitted. The e2e deck gives
   * its sandbox's, so no agent there is given a folder of the developer's.
   */
  worktreesRoot?: string
  /**
   * Where files pasted into terminals are saved, such as an `uploads` folder beside the
   * database; a fresh temporary folder when omitted.
   */
  uploads?: string
  /**
   * Where "Save for debugging" writes a dialog Novadeck could not read (`agents.saveDialog`):
   * a `dialogs` folder beside the logs in the desktop app, beside the database in a standalone
   * runner; a fresh temporary folder when omitted.
   */
  dialogs?: string
  /**
   * The relay agents start for Novadeck's MCP server and hooks, copied in beside the shell files;
   * the one `@novadeck/relay` built by default. The desktop app passes the one it ships.
   */
  relay?: string
  /**
   * Where the tour's seed project and the libraries it runs on are (`TourAssets`); the repository's
   * own files and `node_modules` by default. The desktop app passes the ones it ships.
   */
  tour?: TourAssets
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
  /**
   * Told whether any agent is at work (`agentAtWork`), each time that changes: nothing until
   * one is, and false once the runner closes. The desktop app keeps the computer awake while
   * one is.
   */
  working?: (working: boolean) => void
}

export type Runner = {
  /**
   * Its clients' sessions, for a transport to serve (`serveWebSocket`, `servePort`). Their
   * epoch is this runner's lifetime: terminal cursors are only valid within it. A session
   * that ends releases its attachments and terminal control; its shells keep running.
   */
  readonly sessions: Sessions
  /**
   * What a handshake's token proves of one of the runner's devices (`Devices.verify`), or
   * `undefined` for a token that isn't a device's credential, for a transport to check
   * beside the owner's token.
   */
  device(token: string | undefined): Verdict | undefined
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
  const started: Started[] = []
  try {
    return assemble(store, options, started)
  } catch (error) {
    // A part that can't be built, such as terminals given a limit of 0: what already started
    // ends, then the store, as voice and murmur read settings while they load.
    void Promise.allSettled(started.map((part) => part.close())).finally(() => store.close())
    throw error
  }
}

// A part of the runner that began work as it was built, which must end if the rest can't be.
type Started = { close(): Promise<void> }

/** How often the person's Codex config is looked at for a change. */
const codexConfigPollMs = 3_000

// The runner's parts over its store (see `wire`); each that starts work joins `started`.
const assemble = (store: WorkspaceStore, options: RunnerOptions, started: Started[]) => {
  // Written once, for the shells and for the agents that install Novadeck's plugin.
  const shellFiles =
    options.shell === undefined
      ? Promise.resolve(undefined)
      : installShellFiles(options.shell, {
          ...(options.relay !== undefined && { relay: options.relay }),
          ...(options.worktreesRoot !== undefined && {
            worktrees: options.worktreesRoot,
          }),
          gate: store.settings.runner().shippingGate,
          // Whether Codex is connected is known only once these are written (see below).
          pwsh: "kept",
          fresh: true,
        }).catch((error: unknown) => {
          log.error("shell.integration-unavailable", "Novadeck shell integration is unavailable", {
            err: error,
          })
          return undefined
        })
  // Writes the shell files again, changing only what differs, once Codex is connected or
  // disconnected: on Windows its commands capture through Novadeck's PowerShell, which is
  // installed only while it is connected. Resolves once they are written; fails if they can't be.
  // One writing at a time, as two would share their files' temporary names.
  let rewriting = Promise.resolve()
  const rewriteShellFiles = (): Promise<void> => {
    const shell = options.shell
    if (shell === undefined) return Promise.resolve()
    const write = async () => {
      await installShellFiles(shell, {
        ...(options.relay !== undefined && { relay: options.relay }),
        ...(options.worktreesRoot !== undefined && {
          worktrees: options.worktreesRoot,
        }),
        gate: store.settings.runner().shippingGate,
        pwsh: process.platform === "win32" && (await agents.connected("codex")),
      })
    }
    const done = rewriting.then(write, write)
    rewriting = done.catch(() => {})
    return done
  }
  // The runner's own calls of the relay use the build's, never the copy for agents.
  const relay = options.relay === undefined ? {} : { relay: options.relay }
  const agents = createHarnesses(() => shellFiles, {
    ...relay,
    ...options.agents,
  })
  started.push(agents)
  // Codex's commands on Windows capture once it is found connected, or connected later.
  const setAgent = agents.set
  agents.set = async (agent, connected) => {
    const after = await setAgent(agent, connected)
    if (agent === "codex" && process.platform === "win32") await codexShells()
    return after
  }
  const codexShells = () =>
    shellFiles
      .then(() => rewriteShellFiles())
      .catch((error: unknown) =>
        log.error("shell.codex-failed", "Novadeck could not write Codex's capture", { err: error }),
      )
  if (process.platform === "win32") void codexShells()
  // Codex's shim passes the person's own writable roots with the worktrees' folder, as its
  // config holds them at each launch: an edit to it is written in at once, not at the next
  // start. Its time is looked at every few seconds (`watchFile` stats it, so a config made
  // later or replaced whole counts too).
  if (options.shell !== undefined) {
    const config = codexConfig()
    const changed = () => void codexShells()
    watchFile(config, { interval: codexConfigPollMs, persistent: false }, changed)
    started.push({ close: async () => unwatchFile(config, changed) })
  }
  // A connected agent that keeps its own copy of the plugin gets the files just written,
  // where they differ from that copy (see `Harness.installed`).
  void shellFiles
    .then((written) => (written ? agents.refresh(store.settings.runner().shippingGate) : []))
    .catch((error: unknown) =>
      log.error("harnesses.refresh-failed", "Novadeck could not refresh its plugins", {
        err: error,
      }),
    )
  // What Works remembers of works (first sights, last looks, files read), beside the database,
  // as voice and murmur keep theirs; kept only for a runner that keeps a database.
  const memory =
    options.database === undefined ? undefined : join(dirname(options.database), "works.json")
  // The checkouts' working trees as trees, for the Worktrees panel and the changes items alike;
  // the object folders live beside the memory, which names trees in them.
  const snapshots = new Snapshots({
    held: () => secrets(agents.environment()),
    ...(memory !== undefined && {
      home: join(dirname(memory), "works-objects"),
    }),
  })
  // What agents show and the person attaches beside terminals, kept in the store; it
  // asks the terminals where each one is.
  // Which project each client shows, which agents' requests to a client go by.
  const clients = new ClientWindows((sessionId) => store.session(sessionId).projectId)
  const items = new CompanionItems({
    clients,
    records: store,
    terminal: (terminalId) => terminals.place(terminalId),
    harnessBookkeeping: () => agents.bookkeeping(),
    terminals: (sessionId) =>
      terminals
        .list()
        .filter((terminal) => terminal.sessionId === sessionId)
        .flatMap(({ id }) => terminals.place(id) ?? []),
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
    // Where the person's tools keep their logins, as their login shell says.
    environment: () => agents.environment(),
    snapshots,
    // Compares of remote refs make them current, and keep their repository fetched.
    origin: {
      // Fetched for a compare, not a worktree: the person's checkout is not moved by it.
      fetchBriefly: (commonDir, ms) => worktrees.fetchBriefly(commonDir, ms, false),
      status: (commonDir) => worktrees.originStatus(commonDir),
    },
    // The files of a change the person read, kept with the works.
    reads: {
      marks: (root) => works.marks(root),
      mark: (root, path, blob) => works.markRead(root, path, blob),
    },
  })
  const voice = new Voice(store.settings, {
    ...(options.softwareGraphics !== undefined && {
      softwareGraphics: options.softwareGraphics,
    }),
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
  started.push(voice)
  const murmurDirectory =
    options.murmur?.directory ??
    (options.database === undefined
      ? join(tmpdir(), `novadeck-murmur-${randomUUID()}`)
      : join(dirname(options.database), "murmur"))
  // Murmur is Experimental: it runs only while its switch is on, saved once as Murmur was, and
  // on where its files are, so Addons keeps their Uninstall.
  store.settings.carryMurmurSwitch(hasContents(murmurDirectory))
  const murmur = new Murmur(store.settings, {
    switchedOn: () => store.settings.runner().murmur === true,
    engine: options.murmur?.engine,
    source: options.murmur?.source,
    directory: murmurDirectory,
    ...(options.softwareGraphics !== undefined && {
      softwareGraphics: options.softwareGraphics,
    }),
    // Voice input has priority over the GPU.
    voice: voice.activity,
  })
  murmur.start()
  started.push(murmur)
  // On Linux each shell runs in a systemd scope of its own, so one killed for memory
  // takes down its terminal, not the app. On Windows each runs in a job object of its own,
  // kept by the runner's own relay. On macOS a terminal's processes are those that started
  // with it named in their environment, as every shell starts (`launching.ts`), read through
  // the relay. On all three, what an agent left there ends with the terminal.
  const jobs = windowsJobs(async () => options.relay ?? relayPath)
  if (jobs) started.push({ close: async () => jobs.close() })
  const scopes =
    userScopes() ??
    jobs ??
    taggedScopes(() => Promise.resolve(options.relay ?? relayPath), "NOVADECK_TERMINAL_ID")
  // On macOS and Windows each shell and what it starts run below the window's priority.
  const priority = terminalPriorities()
  // The terminal the person uses in each window keeps the normal share of both.
  const activity = new ActiveTerminals()
  // The terminals in sight at each window, which the runner never moves the view of.
  const seen = new SeenTerminals()
  started.push({ close: async () => activity.stop() })
  // Without a key from the app no transcript is saved or shown.
  const sealer = createTranscriptSealer(options.transcriptKey)
  // Whether an agent works in the worktree now, read afresh each time it is asked: a turn may
  // have started since. A shell command or agent whose current checkout is the worktree counts,
  // whoever's it is. (A command run elsewhere with `git -C` into it can't be seen.)
  const workingIn = async (row: { readonly path: string }): Promise<string | undefined> =>
    (await terminals.checkouts()).some((each) => each.root === row.path && each.working)
      ? "An agent is working in that worktree right now: wait for its turn to end."
      : undefined
  // What owns a worktree is a terminal, live or closed but still in History.
  const worktrees = new Worktrees(store, {
    busy: workingIn,
    owner: (terminalId) =>
      terminals.place(terminalId) !== undefined
        ? "open"
        : store.closedExists(terminalId)
          ? "history"
          : "gone",
    projectFolder: (projectId) => {
      try {
        return store.project(projectId).cwd
      } catch {
        return undefined
      }
    },
    exists: (terminalId) =>
      terminals.place(terminalId) !== undefined || store.terminalExists(terminalId),
    ...(options.worktreesRoot !== undefined && { root: options.worktreesRoot }),
    repositories: () => items.remoteRepositories(),
    // Beside the database, owner-only: where a repository's hooks are pointed away to.
    ...(options.database !== undefined &&
      options.database !== ":memory:" && {
        hooksFolder: join(dirname(options.database), "no-hooks"),
      }),
  })
  // On unless the person turned them off, carried on once for everyone as they left Experimental.
  store.settings.carryWorktreesSwitch()
  // The person's setting, except that the tour's terminals have worktrees whatever it says.
  const worktreesOn = (terminalId?: string): boolean =>
    store.settings.runner().worktrees || (terminalId !== undefined && tour.isTours(terminalId))
  const rootFolder = new RootFolder({
    enabled: () => store.settings.runner().worktrees,
    ...(options.worktreesRoot !== undefined && { path: options.worktreesRoot }),
  })
  rootFolder.ensure()
  // The shipping gate (Experimental): read live, so the switch counts at once.
  const shipping = new Shipping({
    enabled: () => store.settings.runner().shippingGate,
    owned: {
      ofTerminal: (id) => worktrees.ownedRows(id),
      all: () => worktrees.all(),
    },
    notify: (terminalId, text) =>
      shippingTerminals().messaging.notice(terminalId, text, { always: true }),
  })
  // The terminals below are made with the gate, which asks them only once it is answering.
  const shippingTerminals = (): Terminals => terminals
  // Novadeck's own pi (Experimental), fetched into the data folder beside the shell files: its
  // launcher asks for it, and its switch, read live, starts its fetch, here as the runner starts.
  // Only with the shell files, which hold its launcher.
  const bundledPi =
    options.shell === undefined
      ? undefined
      : new BundledPi({
          data: dirname(options.shell),
          enabled: () => store.settings.runner().bundledPi === true,
          // The tour's terminals start it whatever its switch says: the person asked for the tour.
          allows: (terminalId) => tour.paysFor(terminalId),
        })
  bundledPi?.switched()
  const terminals = new Terminals({
    shipping,
    ...(bundledPi && { bundledPi }),
    records: store,
    closed: store,
    projects: () => store.projects().map(({ id }) => id),
    worktrees: {
      service: worktrees,
      enabled: (terminalId) => worktreesOn(terminalId),
      ready: (startedAt, relists, terminalId) =>
        rootFolder.ready(startedAt, relists, terminalId !== undefined && tour.isTours(terminalId)),
      inRepository: repositoryKnown,
      // Read only by MCP calls, which come once the forges below are made.
      pullRequest: (commonDir, branch) => forges.pullRequest(commonDir, branch),
    },
    sealer,
    shellFiles,
    ...relay,
    // Codex runs through Novadeck's shim while it is connected; see `posixCodexShim`.
    shims: () => agents.shims(),
    connected: (agent) => agents.connected(agent),
    connections: agents,
    // Where each harness lives, which says how it may start with a task.
    install: (agent) => agents.install(agent),
    models: (agent) => agents.models(agent),
    // The tour's teammates may not open agents, and its lead's open in the teammates' folder.
    openPolicy: (terminalId) => tour.openPolicy(terminalId),
    // The tour's agents' provider, for the shells that start in its folder.
    launchEnv: (cwd, resumed) => tour.launchEnv(cwd, resumed),
    transcripts: store.settings.runner().transcripts,
    // Read each time idle agents are looked at, so a change in Preferences counts at once.
    hibernateAfterMinutes: () => store.settings.runner().hibernateAfterMinutes,
    agentMode: () => effectiveAgentMode(store.settings.runner()),
    projectFolder: (sessionId) => store.project(store.session(sessionId).projectId).cwd,
    // Agents message each other within a project, and their messages are kept with it.
    messages: store,
    inbox: store,
    projectOf: (sessionId) => store.session(sessionId).projectId,
    clients,
    items,
    // Without an engine nothing is described, so terminals have nothing to wait for.
    ...(options.murmur?.engine !== undefined && { describer: murmur }),
    ...((scopes || priority) && {
      pty: {
        ...(scopes && { scopes }),
        ...(priority && { priority }),
        activity,
      },
    }),
    ...options.terminals,
    // Whatever a test says of the answers, the dialogs still see which terminals are in sight.
    answers: {
      ...(options.dialogs !== undefined && { saves: options.dialogs }),
      ...options.terminals?.answers,
      seen,
    },
  })
  const projects = new Projects(store, terminals, items, worktrees)
  // In the person's home, where the agents are looked for too.
  const tour = new Tour({
    git,
    findProgram,
    // What each run was given, beside the database, so a runner started again still gives the
    // tour's agents their provider (the file holds a ticket: the runner's owner's alone).
    ...(options.database !== undefined &&
      options.database !== ":memory:" && {
        records: new TourRecords(join(dirname(options.database), "tour-runs.json")),
      }),
    ...(options.tour !== undefined && { assets: options.tour }),
    ...(options.agents?.home !== undefined && { home: options.agents.home }),
    // Where the game's server command is looked for: the person's terminal's PATH.
    environment: () => agents.environment(),
    // Novadeck's own pi, which the tour's agents run, downloaded whatever its switch says.
    ...(bundledPi && { ownPi: () => bundledPi.want() }),
    // Every project, those being removed too, whose removal the tour waits for.
    projects: {
      list: () => store.projects(),
      remove: (id) =>
        projects.remove(id).catch((error: unknown) => {
          // Removed meanwhile, as from another window.
          if (!(error instanceof DomainError && error.code === "NOT_FOUND")) throw error
        }),
    },
    notice: (terminalId, text) => terminals.messaging.notice(terminalId, text, { always: true }),
    cwdOf: (terminalId) => terminals.get(terminalId).cwd,
    leadOf: (terminalId) => terminals.messaging.leadOf(terminalId)?.terminalId,
    handleOf: (terminalId) => terminals.get(terminalId).handle,
    worktreesFolder: () => rootFolder.make(),
  })
  // Not awaited: the runner starts at once, and a failure only leaves rows for the next start.
  void worktrees
    .reconcile()
    .catch((error: unknown) =>
      log.error("worktrees.reconcile-failed", "Novadeck could not check its worktrees", {
        err: error,
      }),
    )
    // After it: the owners it found gone leave their merged worktrees to cleanup.
    .finally(() => worktrees.start())
  // Pull requests of the works' branches, from every forge whose tool is there, while the works
  // are watched. There are no switches: a `forges.set` from a client before them saves nothing
  // and leaves the forge on, though one to off drops what it found until its next look.
  const forges = new Forges({
    enabled: () => forgeName.options,
    save: () => {},
    // The branches the works' checkouts are on now, not those they were opened on.
    repositories: () =>
      repositoriesOf(works.branches(), (commonDir) => worktrees.fetchedAt(commonDir)),
    watching: () => works.watched(),
    environment: () => agents.environment(),
    // Listing the agents afresh reads the person's login environment again.
    refreshEnvironment: async () => {
      await agents.list({ fresh: true })
    },
  })
  forges.start()
  started.push(forges)
  keepWorktreeChanges({
    onMade: (listener) => worktrees.onMade(listener),
    onChanged: (listener) => worktrees.onChanged(listener),
    enabled: (terminalId) => worktreesOn(terminalId),
    owner: (root) => worktrees.all().find((row) => row.path === root)?.terminalId,
    place: (terminalId) => terminals.place(terminalId),
    show: (place, root) => items.showChangesUnlessShown(place, root),
    closeOn: (terminalId, root) => items.closeChangesOn(terminalId, root),
    closeAll: (root) => items.closeChangesAt(root),
  })
  const works = new Works({
    pullRequest: (commonDir, branch) => forges.pullRequest(commonDir, branch),
    tracked: () =>
      worktrees
        .all()
        .map(({ path, projectId, terminalId, createdAt, commonDir, base, adopted }) => ({
          commonDir,
          root: path,
          projectId,
          terminalId,
          createdAt,
          adopted,
          base,
          fetchedAt: worktrees.fetchedAt(commonDir),
        })),
    presences: async () =>
      (await terminals.checkouts()).map(({ terminalId, root, working }) => ({
        terminalId,
        root,
        working,
      })),
    show: async (terminalId, root) => {
      const place = terminals.place(terminalId)
      if (!place) throw new DomainError("TERMINAL_NOT_FOUND")
      // The person asked, so it opens, as an agent's show does when told the person asked.
      const shown = await items.show(place, {
        changes: { path: root },
        open: true,
      })
      if (!shown.ok) throw new DomainError("NOT_FOUND", shown.reason)
      return shown.id
    },
    // The person is the actor: whoever owns the worktree, it closes on their say, in the
    // service's own queue, so it can't race an agent's take, give or close.
    remove: (root, force, safe) => worktrees.closeAt(root, force, workingIn, safe),
    onMade: (listener) => worktrees.onMade(listener),
    fetch: (commonDirs) => worktrees.fetchNow(commonDirs),
    origin: (commonDir) => worktrees.originStatus(commonDir),
    projectFolder: (projectId) => {
      try {
        return store.project(projectId).cwd
      } catch {
        return undefined
      }
    },
    snapshots,
    held: () => secrets(agents.environment()),
    ...(memory !== undefined && { memory }),
  })
  const checkouts = new MainCheckouts({
    moved: (commonDir) => worktrees.moved(commonDir),
    update: (commonDir) => worktrees.update(commonDir),
  })
  const uploads = new Uploads(options.uploads)
  void uploads.sweepOld()
  return {
    store,
    shellFiles,
    rewriteShellFiles,
    agents,
    terminals,
    shipping,
    bundledPi,
    items,
    projects,
    works,
    checkouts,
    forges,
    worktrees,
    snapshots,
    uploads,
    voice,
    murmur,
    jobs,
    sealer,
    rootFolder,
    tour,
    activity,
    clients,
    seen,
  }
}

/**
 * What stands in for a runner whose workspace a newer Novadeck wrote: it owns nothing, and
 * tells every client that proves itself why (`WORKSPACE_TOO_NEW`).
 */
const refusingRunner = (): Runner => ({
  // A client that proves itself is told why, and nothing else is served. The runner stays
  // up, so a client that retries is told again instead of finding a process that crashed.
  sessions: createSessions({
    revision: compatibility.revision,
    oldestClient: compatibility.oldestClient,
    router: {},
    admit: () => {
      throw new ORPCError("WORKSPACE_TOO_NEW", {
        status: errors.WORKSPACE_TOO_NEW.status,
      })
    },
  }),
  // Its devices are in the workspace it can't open: only the owner is told why.
  device: () => undefined,
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
  if (
    error instanceof DomainError ||
    error instanceof TerminalError ||
    error instanceof TourError ||
    error instanceof ORPCError
  )
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
  const {
    store,
    shellFiles,
    rewriteShellFiles,
    terminals,
    shipping,
    bundledPi,
    items,
    agents,
    projects,
    works,
    checkouts,
    forges,
    worktrees,
    snapshots,
    uploads,
    voice,
    murmur,
    jobs,
    sealer,
    rootFolder,
    tour,
    activity,
    clients,
    seen,
  } = wire(options)
  let closing: Promise<void> | undefined
  if (options.working)
    watchWorking(terminals.watch(workingWatcher), options.working, (id) =>
      terminals.scheduled(id),
    ).catch((error: unknown) =>
      log.error("working.failed", "Novadeck stopped following whether agents work", {
        err: error,
      }),
    )
  const devices = new Devices(store.devices)
  const sessions = createSessions({
    revision: compatibility.revision,
    oldestClient: compatibility.oldestClient,
    router: createRouter({
      store,
      terminals,
      feedback: terminals.feedback,
      history: terminals.history,
      works,
      checkouts,
      forges,
      projects,
      items,
      agents,
      uploads,
      voice,
      murmur,
      transcriptsAvailable: () => transcriptsAvailable(sealer),
      closing: () => closing !== undefined,
      settingsSaved: () => rootFolder.ensure(),
      // The shipping gate's switch: Claude's per-launch settings and Codex's plugin carry its
      // hooks, so they are written again, and a Codex copy that differs is installed again.
      shipping,
      ...(bundledPi && { bundledPi }),
      shippingSwitched: () => {
        // Switched off, its open cards and permits end, and the terminals' summaries say so.
        shipping.switched()
        void shellFiles
          .then(() => rewriteShellFiles())
          .then(() => agents.refresh(true))
          .catch((error: unknown) =>
            log.error("shipping.rewrite-failed", "Novadeck could not write the gate's hooks", {
              err: error,
            }),
          )
      },
      tour,
      activity,
      clients,
      seen,
      devices,
    }),
    error: apiError,
    failed: logFailure,
    // Each line names the device a session proved itself as, by its id: null for the owner.
    admit: (session) =>
      log.info("client.connected", "A client connected.", {
        data: { session: session.id, device: session.device?.id ?? null },
      }),
    // Whatever a client held through a session it lost or replaced: its shells keep running.
    closed: (session) => {
      log.info("client.closed", "A client's session ended.", {
        data: { session: session.id, device: session.device?.id ?? null },
      })
      activity.release(session.id)
      clients.release(session.id)
      seen.release(session.id)
      terminals.release(session.id)
      works.release(session.id)
      voice.release(session.id)
      murmur.release(session.id)
      // Last, and never failing the rest: a store that can't write (a full disk) only misses
      // when the device was last seen.
      if (!closing)
        try {
          devices.ended(session)
        } catch (error) {
          log.warn("device.unseen", "Novadeck could not note when a device was last seen.", {
            err: error,
          })
        }
    },
  })
  devices.serve(sessions)
  return {
    sessions,
    device: (token) => devices.verify(token),
    snapshotBytes: options.terminals?.snapshotBytes ?? 32 * 1024 * 1024,
    persist: () => {
      if (!closing) terminals.persist()
    },
    close() {
      closing ??= (async () => {
        // No new removal starts once the runner closes; one under way ends before the store.
        const tidying = worktrees.stop()
        try {
          await terminals.shutdown()
        } finally {
          // After the terminals, whose leftovers it lists and ends as they close.
          jobs?.close()
          await forges.close()
          await works.close()
          await tidying
          // After both that take snapshots: the items ended with the terminals.
          await snapshots.close()
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
