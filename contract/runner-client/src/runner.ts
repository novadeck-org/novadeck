import {
  contract,
  maxUploadBytes,
  maxUploadPartLength,
  maxVoicePartLength,
  protocolVersion,
  type AgentDetail,
  type AgentIntegration,
  type AgentName,
  type Approval,
  type ApprovalAnswer,
  type AskAnswer,
  type CompanionChange,
  type CompanionItem,
  type CompanionWindow,
  type FeedbackDraft,
  type FolderListing,
  type InboxEntry,
  type InterruptResult,
  type ItemContent,
  type MurmurSettings,
  type MurmurState,
  type PageLook,
  type PageLookAnswer,
  type PageTrouble,
  type PlanSaveResult,
  type Project,
  type RequestAnswer,
  type RunnerSettings,
  type RunnerSettingsState,
  type TerminalChange,
  type TerminalMessages,
  type TerminalRequest,
  type TerminalRequestAnswer,
  type TerminalSummary,
  type TranscriptChange,
  type VoiceChange,
  type VoiceState,
  type VoiceTranscript,
  type WireClient,
  type WorkspaceSession,
} from "@novadeck/protocol"
import { WireError } from "@novadeck/wire"
import { connect, type Transport, type WireStatus } from "@novadeck/wire/client"

import { lost, type RunnerErrorCode } from "./errors.js"
import { followAll, followRestarting, type Reset } from "./follow.js"
import { base64Parts } from "./parts.js"
import { attachTerminal, type AttachedTerminal, type TerminalMode } from "./terminal.js"

export type ConnectOptions = {
  /** Cancels the initial connection. Afterwards, use `runner.close()`. */
  readonly signal?: AbortSignal
  /** Milliseconds to wait before reconnection attempt `attempt`, counting from zero. */
  readonly retryDelay?: (attempt: number) => number
  /** Milliseconds a connection may take to open and complete its handshake. */
  readonly timeoutMs?: number
}

/**
 * An item of `runner.terminals.watch()`: a runner change, or `reset`, which the client
 * yields before each fresh `changed`…`synced` sequence.
 */
export type TerminalWatchItem = TerminalChange | Reset

/**
 * An item of `runner.companions.watch()`: a runner change, or `reset`, which the client
 * yields before each fresh sequence of items and windows ending in `synced`.
 */
export type CompanionWatchItem = CompanionChange | Reset

export type Runner = {
  readonly status: WireStatus
  /**
   * Yields the current status, then the latest one after each change, until the runner
   * closes. Quick successive changes may be coalesced. `break` stops it at any time.
   */
  watch(): AsyncIterableIterator<WireStatus>
  readonly projects: {
    list(): Promise<Project[]>
    /**
     * The client names the project with a fresh UUID; a taken one rejects with
     * `CONFLICT`. Without `cwd`, the project opens in the runner owner's home directory.
     */
    create(input: {
      readonly id: string
      readonly name: string
      readonly cwd?: string
    }): Promise<Project>
    rename(input: { readonly projectId: string; readonly name: string }): Promise<Project>
    /**
     * Closes every terminal of the project's sessions, whichever connection controls
     * them, so watchers see each `removed`, then forgets the project, its sessions and its
     * agents' messages. Rejects with `NOT_FOUND` for a project the runner doesn't have, as
     * one already removed, and with `CLOSING` when the runner shuts down first.
     */
    remove(input: { readonly projectId: string }): Promise<void>
    /**
     * Keeps the person's arrangement of the projects: `order` by id, first to last, and the
     * ones `pinned`, at most nine, the first in `order` (one `order` doesn't name isn't
     * pinned). Unknown ids are ignored, and projects `order` leaves out follow, in the order
     * they were added.
     */
    arrange(input: {
      readonly order: readonly string[]
      readonly pinned: readonly string[]
    }): Promise<void>
    /**
     * One folder of the project's directory as it is now, by its path from the project's
     * root with `/` between names ("" for the root); the entries come sorted, folders
     * first, and never include `.git`. Rejects with `NOT_FOUND` for a project the runner
     * doesn't have, and `INVALID_DIRECTORY` for a folder that is missing, no folder, or
     * outside the project's directory.
     */
    folder(input: { readonly projectId: string; readonly folder: string }): Promise<FolderListing>
  }
  readonly sessions: {
    list(input: { readonly projectId: string }): Promise<WorkspaceSession[]>
    /** The client names the session with a fresh UUID; a taken one rejects with `CONFLICT`. */
    create(input: {
      readonly id: string
      readonly projectId: string
      readonly name: string
    }): Promise<WorkspaceSession>
    rename(input: { readonly sessionId: string; readonly name: string }): Promise<WorkspaceSession>
    /**
     * Replaces the session's `state`, which the runner stores without reading, and its
     * `visitedAt`: null while the person has never had it open.
     */
    save(input: {
      readonly sessionId: string
      readonly state: string
      readonly visitedAt: number | null
    }): Promise<void>
  }
  readonly terminals: {
    list(input: { readonly sessionId: string }): Promise<TerminalSummary[]>
    /**
     * Starts a shell in the session's project directory unless `cwd` is given. The
     * client names the terminal with a fresh UUID; a taken one, even by an exited
     * terminal the runner still retains, rejects with `CONFLICT`.
     */
    create(input: {
      readonly id: string
      readonly sessionId: string
      readonly cwd?: string
      readonly cols: number
      readonly rows: number
      /**
       * Starts where the runner's saved record of this terminal left off: in its last
       * directory, with its saved transcript shown before the shell's output.
       */
      readonly restore?: boolean
      /**
       * The agent that ran there: while it is connected, the runner resumes the session
       * it last reported in this terminal, and shows no transcript.
       */
      readonly resume?: AgentName
      /**
       * Runs once at the shell's first prompt, as if typed there; never with `restore` or
       * `resume`. A shell that can't run one rejects with `SPAWN_FAILED`.
       */
      readonly command?: string
      /**
       * Its title, the person's; a restored terminal keeps its saved one, and a new one
       * takes the session's next default, when left out.
       */
      readonly title?: string
      /**
       * The agent's request this terminal answers: it takes the title that agent asked
       * for, as the agent's.
       */
      readonly requestId?: string
    }): Promise<TerminalSummary>
    /**
     * Follows agents' requests for a new terminal, made through Novadeck's MCP server,
     * across reconnections. The runner sends each to the client that subscribed last and
     * waits a few seconds for `answerRequest`; iteration ends when the runner closes or on
     * `return()`.
     */
    requests(): AsyncIterableIterator<TerminalRequest, undefined>
    /**
     * Answers a request with the terminal this client opened for it, or why it didn't.
     * Rejects with `NOT_FOUND` once the runner no longer waits for it.
     */
    answerRequest(answer: TerminalRequestAnswer): Promise<void>
    /**
     * Follows agents' requests, made through Novadeck's MCP server, to close a terminal that
     * runs an agent they don't lead, or to lead one, across reconnections. The runner
     * sends each to the client that subscribed last and waits, without a time limit, for
     * `answerApproval` or until it withdraws the request; iteration ends when the runner
     * closes or on `return()`.
     */
    approvals(): AsyncIterableIterator<Approval, undefined>
    /**
     * Answers an approval with the person's choice. Rejects with `NOT_FOUND` once the
     * runner no longer waits for it.
     */
    answerApproval(answer: ApprovalAnswer): Promise<void>
    /**
     * Ends a terminal's lead, as the person: the agent's messages are a peer's from then
     * on. Does nothing for a terminal with no lead; rejects with `TERMINAL_NOT_FOUND` for
     * one the runner doesn't hold.
     */
    release(terminalId: string): Promise<void>
    /**
     * Follows every terminal on the runner, across sessions. Each time the stream opens,
     * first and again after every reconnection or retried refusal, it yields `reset`,
     * then `changed` for each terminal, then `synced`. On `reset`, clear the set of
     * reported terminals; at `synced`, forget any terminal not reported since, for
     * example one that ended with a restarted runner. Later events report creation,
     * foreground process, size and exit changes, and `removed` for closed or evicted
     * records. Quick successive changes of one terminal may be coalesced. Refusals such
     * as `RESOURCE_LIMIT` are retried with a growing delay; iteration ends only when
     * the runner closes or on `return()`.
     */
    watch(): AsyncIterableIterator<TerminalWatchItem, undefined>
    /**
     * Closes the terminal for good, whoever controls it: the runner forgets it at once,
     * so `list` omits it, watchers see `removed` and a restart does not bring it back,
     * then ends its shell. Needs no attachment.
     */
    close(terminalId: string): Promise<void>
    /**
     * Renames a terminal; the runner keeps the title and `watch` reports it. Rejects with
     * `TERMINAL_NOT_FOUND` for a terminal the runner keeps nothing of.
     */
    rename(terminalId: string, title: string): Promise<void>
    /**
     * Takes away the title the person gave a terminal, so its title is automatic again:
     * murmur's latest, else the one the agent that opened it gave, or its default.
     * Rejects as `rename` does.
     */
    resetTitle(terminalId: string): Promise<void>
    /**
     * Saves a file pasted into a terminal on the runner's machine, sending it in
     * parts that each fit a message, and resolves with its absolute path there. Rejects
     * with `UPLOAD_TOO_LARGE` past `maxUploadBytes`, before sending anything, and as
     * `rename` does.
     */
    upload(
      terminalId: string,
      file: { readonly name: string; readonly data: Uint8Array },
    ): Promise<string>
    /**
     * Starts a fresh shell in an exited terminal the runner still holds, keeping its id,
     * session and directory, and gives this client control. Attach again for the new
     * screen. Rejects with `CONFLICT` while it runs and `SPAWN_FAILED` when the shell
     * cannot start, which leaves it exited.
     */
    restart(
      terminalId: string,
      options: { readonly cols: number; readonly rows: number; readonly resume?: AgentName },
    ): Promise<TerminalSummary>
    /** Resolves once the runner has granted the attachment; `control` is the default mode. */
    attach(
      terminalId: string,
      options?: { readonly mode?: TerminalMode },
    ): Promise<AttachedTerminal>
  }
  readonly agents: {
    list(): Promise<AgentIntegration[]>
    /**
     * Follows what the agent in a terminal does, in detail: a snapshot, then another on
     * each change, across reconnections, with a fresh one when the stream is opened again. It
     * follows the terminal from agent to agent; iteration ends once the terminal is gone,
     * when the runner closes, or on `return()`.
     */
    detail(terminalId: string): AsyncIterableIterator<AgentDetail, undefined>
    /**
     * Follows an actor's conversation, by the ref `detail` names it by: every item its
     * harness recorded, then each later one. After a reconnection the items follow again
     * from the start, after a `reset`. Iteration ends once the terminal's agent has left
     * the actor's session, the actor or its transcript is not found, the runner closes,
     * or on `return()`.
     */
    transcript(
      terminalId: string,
      actor: string,
    ): AsyncIterableIterator<TranscriptChange, undefined>
    /**
     * Gives the terminal's agent a prompt as the person would type it: pasted into its
     * input box, then Enter once exactly the text shows there. Rejects with `CONFLICT`
     * without an agent bound or when its box holds a draft already, `PROMPT_FAILED` when the
     * paste never showed as exactly the text, and `PROMPT_REFUSED`, writing nothing, for
     * text the agent's TUI would read as more than a message: one starting with `/` or `!`,
     * ending in an `@` or `$` mention a picker would take the Enter for, holding a control
     * character, or nothing but white space; see `promptRefusal`.
     */
    prompt(terminalId: string, text: string, automatic?: true): Promise<void>
    /**
     * Answers a request waiting on the person through its dialog in the agent's TUI, by the
     * ref `detail` names it by. Rejects with `NOT_FOUND` for a request it doesn't have,
     * `CONFLICT` when the dialog isn't on screen, isn't recognised or doesn't take that
     * answer, and `DIALOG_CHANGED` when it no longer reads as the one the answer names
     * (nothing pressed either way, and `DIALOG_CHANGED` leaves the dialog as it is), and
     * `ANSWER_FAILED` when the keys didn't take, after which the request's dialog is `raw`,
     * and `PROMPT_REFUSED` when the words that follow it as a prompt are ones `promptRefusal`
     * refuses (nothing pressed), and `WORDS_NOT_SENT` when the answer took but the words that
     * follow it as the agent's next prompt did not go (the dialog was answered).
     */
    answer(terminalId: string, request: string, answer: RequestAnswer): Promise<void>
    /**
     * Presses Escape in the terminal's agent, stopping its turn; `CONFLICT` without one.
     * Resolves with the queued words the agent's box took back, cleared out of it, for the
     * chat to put back in the person's draft (`returned`, null for none, and for Codex);
     * rejects with `BOX_NOT_CLEARED` when the box still holds them: the turn is stopped, and
     * the person is to clear the box in the terminal.
     */
    interrupt(terminalId: string): Promise<InterruptResult>
    /**
     * Installs or removes Novadeck's plugin in the agent through its own commands;
     * rejects with `AGENT_SETUP_FAILED` saying why when that did not work.
     */
    set(agent: AgentName, connected: boolean): Promise<AgentIntegration>
  }
  /**
   * What agents show and the person attaches beside terminals: items, each held by a
   * terminal's bar or a window, kept across restarts as pointers.
   */
  readonly companions: {
    /** A session's items and windows; `NOT_FOUND` for an unknown session. */
    list(input: {
      readonly sessionId: string
    }): Promise<{ items: CompanionItem[]; windows: CompanionWindow[] }>
    /**
     * Follows every item and window on the runner, across sessions, as `terminals.watch()`
     * follows terminals: each time the stream opens it yields `reset`, every item and window,
     * then `synced`; at `synced`, forget any not reported since. Later events
     * report changes and removals, each the latest state of its item or window, in the
     * order they first changed since this client last caught up. A reference may name an
     * item, window or terminal not yet reported, or one whose removal follows: keep both
     * sides and resolve them as the rest arrives, never drop one for it. Iteration ends
     * only when the runner closes or on `return()`.
     */
    watch(): AsyncIterableIterator<CompanionWatchItem, undefined>
    /**
     * Follows what an item points at: read now, then again each time it changes, across
     * reconnections. A file that may hold secrets is `held` unless `reveal` is the
     * path the item points at, the file the person chose to show. Iteration
     * ends once the item is deleted, the runner closes, or on `return()`.
     */
    content(
      itemId: string,
      options?: { readonly reveal?: string },
    ): AsyncIterableIterator<ItemContent, undefined>
    /**
     * Writes the person's edit to a plan kept in a file, unless it changed since `basedOn`,
     * the stamp the edit was made on: then nothing is written and the plan as it now
     * stands is `current`. Rejects with `NOT_FOUND`, or `PLAN_UNWRITABLE` saying why for a
     * plan the agent keeps in its transcript, past 256 KiB, a file gone, or in a folder the
     * runner may not write to (or no plan at all).
     */
    save(input: {
      readonly itemId: string
      readonly text: string
      readonly basedOn: string
    }): Promise<PlanSaveResult>
    /**
     * Attaches a file to a terminal's bar, by a path absolute or from the terminal's
     * directory. Rejects with `TERMINAL_NOT_FOUND`, or `INVALID_FILE` saying why.
     */
    attach(input: {
      readonly terminalId: string
      readonly path: string
      readonly lines?: { readonly from: number; readonly to: number }
      readonly title?: string
    }): Promise<CompanionItem>
    /**
     * Opens a file in the session's project window, by a path absolute or from the
     * session's project folder: the window's item is pointed at it, or, with none yet, the
     * window is made under `windowId`. Rejects with `NOT_FOUND` for an unknown session,
     * `CONFLICT` for a taken window id, or `INVALID_FILE` saying why.
     */
    openInProject(input: {
      readonly sessionId: string
      readonly path: string
      readonly windowId: string
    }): Promise<{ item: CompanionItem; window: CompanionWindow }>
    /**
     * Moves an item onto a terminal's bar, from a bar or a window, which goes with it.
     * Rejects with `NOT_FOUND`, `TERMINAL_NOT_FOUND`, or `CONFLICT` for another session or
     * a project window's item.
     */
    move(itemId: string, terminalId: string): Promise<CompanionItem>
    /**
     * Moves an item into a new window this client names; a taken id, or a project window's
     * item, rejects with `CONFLICT`.
     */
    undock(itemId: string, windowId: string): Promise<CompanionWindow>
    /** Deletes an item and the window holding it. */
    close(itemId: string): Promise<void>
    /**
     * Gives a window the person's title; `NOT_FOUND` for an unknown window, `CONFLICT` for
     * a project window, which its file names.
     */
    renameWindow(windowId: string, title: string): Promise<void>
    /** Gives a window its item's name again; rejects as `renameWindow` does. */
    resetWindowTitle(windowId: string): Promise<void>
    /** What went wrong on a page item during its show `shown`, as the pane saw it. */
    pageTrouble(input: {
      readonly itemId: string
      readonly shown: number
      readonly troubles: PageTrouble[]
    }): Promise<void>
    /**
     * Follows agents' looks at a page item, made through Novadeck's MCP server. The runner
     * sends each to the client that followed last and waits a few seconds for `answerLook`;
     * iteration ends when the runner closes or on `return()`.
     */
    looks(): AsyncIterableIterator<PageLook, undefined>
    /**
     * Answers a look with a picture of the page, or why there is none. Rejects with `NOT_FOUND`
     * once the runner no longer waits for it.
     */
    answerLook(answer: PageLookAnswer): Promise<void>
  }
  /** The person's Inbox: what agents ask and tell them. */
  readonly inbox: {
    list(): Promise<InboxEntry[]>
    /**
     * Follows the Inbox: its entries, then again on each change, across reconnections, with a
     * fresh list when the stream is opened again. Iteration ends when the runner closes, or on
     * `return()`.
     */
    watch(): AsyncIterableIterator<InboxEntry[], undefined>
    /** Answers an agent's ask with the person's answer. */
    answer(id: string, answer: AskAnswer): Promise<void>
    /**
     * Marks entries read: a tell stays as history, a finished turn is removed, an ask is not
     * touched. Unknown ids are skipped.
     */
    read(ids: readonly string[]): Promise<void>
    /**
     * Dismisses an open ask without answering it: it stays listed, settled, and its agent is
     * told. Rejects with `NOT_FOUND` for one that isn't an open ask.
     */
    dismiss(id: string): Promise<void>
    /** Removes settled asks; unknown ids, and any entry that isn't a settled ask, are skipped. */
    clear(ids: readonly string[]): Promise<void>
  }
  readonly feedback: {
    /** The agents' feedback drafts waiting for the app, oldest first, then again on each change. */
    watch(): AsyncIterableIterator<FeedbackDraft[], undefined>
    /** Drops a draft the app sent or the person discarded; `NOT_FOUND` when none is held. */
    settle(id: string, outcome: "sent" | "discarded"): Promise<void>
    /** Asks the agent in a terminal for feedback, with the person's hint (empty for none). */
    ask(terminalId: string, hint: string): Promise<void>
  }
  readonly messages: {
    /** A terminal's threads and messages with their states; `TERMINAL_NOT_FOUND` when unknown. */
    list(terminalId: string): Promise<TerminalMessages>
    /**
     * Follows a terminal's threads and messages: what `list` says, then again on each
     * change to them, to its delivery state or to the pause, across reconnections.
     * Iteration ends once the terminal is gone, the runner closes, or on `return()`.
     */
    watch(terminalId: string): AsyncIterableIterator<TerminalMessages, undefined>
    /**
     * Pauses messaging across the whole runner, every project and session, or resumes it;
     * the runner keeps the switch.
     */
    pause(paused: boolean): Promise<void>
    /**
     * Releases a held thread, and its pair's other held threads: their holds end and their
     * messages go on. Rejects with `NOT_FOUND` for a thread the runner doesn't keep.
     */
    release(thread: string): Promise<void>
    /**
     * Stops a thread: its messages not yet delivered or leased are gone, their senders told
     * the person stopped it, and the pair may not send to each other for a while. Rejects
     * with `NOT_FOUND` for a thread the runner doesn't keep; stopping a stopped thread does
     * nothing.
     */
    stop(thread: string): Promise<void>
  }
  readonly voice: {
    /**
     * Follows the voice input addon: its state, then again on each change, across
     * reconnections, with a fresh one when the stream is opened again. Iteration ends when the
     * runner closes, or on `return()`.
     */
    watch(): AsyncIterableIterator<VoiceState, undefined>
    /**
     * Starts installing the engine, if missing, and the model that suits this computer; `watch`
     * shows progress.
     */
    install(): Promise<void>
    /** Stops an install. */
    cancel(): Promise<void>
    /** Removes the engine and every model, and turns voice input off. */
    uninstall(): Promise<void>
    /** Changes the settings given; the others stay. */
    set(settings: VoiceChange): Promise<void>
    /**
     * Adds 16 kHz mono 16-bit little-endian PCM to a clip the caller names, at the byte
     * `offset` into it, in as many calls as it takes.
     */
    record(clipId: string, offset: number, audio: Uint8Array): Promise<void>
    /**
     * Transcribes a recorded clip and forgets it; `terminalId` names the terminal it is
     * dictated into, whose words the runner hints to the engine.
     */
    transcribe(clipId: string, options?: { readonly terminalId?: string }): Promise<VoiceTranscript>
    /** Forgets a clip without transcribing it. */
    discard(clipId: string): Promise<void>
  }
  readonly murmur: {
    /**
     * Follows the murmur addon: its state, then again on each change, across
     * reconnections, with a fresh one when the stream is opened again. Iteration ends when the
     * runner closes, or on `return()`.
     */
    watch(): AsyncIterableIterator<MurmurState, undefined>
    /** Starts installing the engine, if missing, and the model; `watch` shows progress. */
    install(): Promise<void>
    /** Stops an install. */
    cancel(): Promise<void>
    /** Removes the engine and the model, and turns murmur off. */
    uninstall(): Promise<void>
    /** Changes the settings given; the others stay. */
    set(settings: Partial<MurmurSettings>): Promise<void>
    /** Counts a session of the app the one-time offer was shown in. */
    noteOffered(): Promise<void>
  }
  readonly settings: {
    get(): Promise<RunnerSettingsState>
    /** Changes the settings given; the others stay. */
    set(settings: Partial<RunnerSettings>): Promise<void>
  }
  /** Disconnects. Attached terminals finish; their shells keep running on the runner. */
  close(): Promise<void>
}

/**
 * Connects to a runner and resolves after the first successful handshake. Later
 * disconnections reconnect automatically; `status` and `watch()` report them.
 * Calls made while reconnecting reject with `DISCONNECTED` and are never retried.
 */
export const connectRunner = async (
  transport: Transport,
  options: ConnectOptions = {},
): Promise<Runner> => {
  const connection = await connect({
    ...options,
    contract,
    transport,
    protocolVersion,
    fatal: (code) => code === "WORKSPACE_TOO_NEW",
  })
  const call = async <T>(operation: (client: WireClient) => Promise<T>): Promise<T> => {
    const session = connection.session()
    try {
      return await operation(session.client)
    } catch (error) {
      throw lost(error, session)
    }
  }
  return {
    get status() {
      return connection.status.value
    },
    watch: () => connection.status.watch(),
    projects: {
      list: () => call((client) => client.projects.list()),
      create: (input) => call((client) => client.projects.create(input)),
      rename: (input) => call((client) => client.projects.rename(input)),
      remove: (input) => call((client) => client.projects.remove(input)),
      arrange: (input) =>
        call((client) =>
          client.projects.arrange({ order: [...input.order], pinned: [...input.pinned] }),
        ),
      folder: (input) => call((client) => client.projects.folder(input)),
    },
    sessions: {
      list: (input) => call((client) => client.sessions.list(input)),
      create: (input) => call((client) => client.sessions.create(input)),
      rename: (input) => call((client) => client.sessions.rename(input)),
      save: (input) => call((client) => client.sessions.save(input)),
    },
    terminals: {
      list: (input) => call((client) => client.terminals.list(input)),
      create: (input) => call((client) => client.terminals.create(input)),
      requests: () =>
        followRestarting(connection, (client, signal) =>
          client.terminals.requests(undefined, { signal }),
        ),
      answerRequest: (answer) => call((client) => client.terminals.answerRequest(answer)),
      approvals: () =>
        followRestarting(connection, (client, signal) =>
          client.terminals.approvals(undefined, { signal }),
        ),
      answerApproval: (answer) => call((client) => client.terminals.answerApproval(answer)),
      release: (terminalId) => call((client) => client.terminals.release({ terminalId })),
      watch: () =>
        followAll(connection, (client, signal) => client.terminals.watch(undefined, { signal })),
      close: (terminalId) => call((client) => client.terminals.close({ terminalId })),
      rename: (terminalId, title) =>
        call((client) => client.terminals.rename({ terminalId, title })),
      resetTitle: (terminalId) => call((client) => client.terminals.resetTitle({ terminalId })),
      async upload(terminalId, { name, data }) {
        if (data.length > maxUploadBytes) throw new WireError<RunnerErrorCode>("UPLOAD_TOO_LARGE")
        const [first, ...rest] = base64Parts(data, maxUploadPartLength)
        const started = await call((client) =>
          client.terminals.upload({ terminalId, name, data: first?.data ?? "" }),
        )
        // Each later part adds to the file the first one started.
        for (const part of rest)
          // eslint-disable-next-line no-await-in-loop -- Parts arrive in order.
          await call((client) =>
            client.terminals.upload({ terminalId, path: started.path, data: part.data }),
          )
        return started.path
      },
      restart: (terminalId, { cols, rows, resume }) =>
        call((client) =>
          client.terminals.restart({ terminalId, cols, rows, ...(resume && { resume }) }),
        ),
      attach: (terminalId, { mode = "control" } = {}) =>
        attachTerminal(connection, terminalId, mode),
    },
    agents: {
      list: () => call((client) => client.agents.list()),
      detail: (terminalId) =>
        followRestarting(connection, (client, signal) =>
          client.agents.detail({ terminalId }, { signal }),
        ),
      transcript: (terminalId, actor) =>
        followRestarting<TranscriptChange>(
          connection,
          (client, signal) => client.agents.transcript({ terminalId, actor }, { signal }),
          { type: "reset" },
        ),
      prompt: (terminalId, text, automatic) =>
        call((client) =>
          client.agents.prompt({ terminalId, text, ...(automatic && { automatic }) }),
        ),
      answer: (terminalId, request, answer) =>
        call((client) => client.agents.answer({ terminalId, request, answer })),
      interrupt: (terminalId) => call((client) => client.agents.interrupt({ terminalId })),
      set: (agent, connected) => call((client) => client.agents.set({ agent, connected })),
    },
    companions: {
      list: (input) => call((client) => client.companions.list(input)),
      watch: () =>
        followAll(connection, (client, signal) => client.companions.watch(undefined, { signal })),
      content: (itemId, { reveal } = {}) =>
        followRestarting(connection, (client, signal) =>
          client.companions.content(
            { itemId, ...(reveal !== undefined && { reveal }) },
            { signal },
          ),
        ),
      save: (input) => call((client) => client.companions.save(input)),
      attach: (input) => call((client) => client.companions.attach(input)),
      openInProject: (input) => call((client) => client.companions.openInProject(input)),
      move: (itemId, terminalId) =>
        call((client) => client.companions.move({ itemId, terminalId })),
      undock: (itemId, windowId) =>
        call((client) => client.companions.undock({ itemId, windowId })),
      close: (itemId) => call((client) => client.companions.close({ itemId })),
      renameWindow: (windowId, title) =>
        call((client) => client.companions.renameWindow({ windowId, title })),
      resetWindowTitle: (windowId) =>
        call((client) => client.companions.resetWindowTitle({ windowId })),
      pageTrouble: (input) => call((client) => client.companions.pageTrouble(input)),
      looks: () =>
        followRestarting(connection, (client, signal) =>
          client.companions.looks(undefined, { signal }),
        ),
      answerLook: (answer) => call((client) => client.companions.answerLook(answer)),
    },
    inbox: {
      list: () => call((client) => client.inbox.list()),
      watch: () =>
        followRestarting(connection, (client, signal) => client.inbox.watch(undefined, { signal })),
      answer: (id, answer) => call((client) => client.inbox.answer({ id, answer })),
      read: (ids) => call((client) => client.inbox.read({ ids: [...ids] })),
      dismiss: (id) => call((client) => client.inbox.dismiss({ id })),
      clear: (ids) => call((client) => client.inbox.clear({ ids: [...ids] })),
    },
    feedback: {
      watch: () =>
        followRestarting(connection, (client, signal) =>
          client.feedback.watch(undefined, { signal }),
        ),
      settle: (id, outcome) => call((client) => client.feedback.settle({ id, outcome })),
      ask: (terminalId, hint) => call((client) => client.feedback.ask({ terminalId, hint })),
    },
    messages: {
      list: (terminalId) => call((client) => client.messages.list({ terminalId })),
      watch: (terminalId) =>
        followRestarting(connection, (client, signal) =>
          client.messages.watch({ terminalId }, { signal }),
        ),
      pause: (paused) => call((client) => client.messages.pause({ paused })),
      release: (thread) => call((client) => client.messages.release({ thread })),
      stop: (thread) => call((client) => client.messages.stop({ thread })),
    },
    voice: {
      watch: () =>
        followRestarting(connection, (client, signal) => client.voice.watch(undefined, { signal })),
      install: () => call((client) => client.voice.install()),
      cancel: () => call((client) => client.voice.cancel()),
      uninstall: () => call((client) => client.voice.uninstall()),
      set: (settings) => call((client) => client.voice.set(settings)),
      async record(clipId, offset, audio) {
        for (const part of base64Parts(audio, maxVoicePartLength))
          // eslint-disable-next-line no-await-in-loop -- Parts arrive in order.
          await call((client) =>
            client.voice.record({ clipId, offset: offset + part.offset, data: part.data }),
          )
      },
      transcribe: (clipId, { terminalId } = {}) =>
        call((client) => client.voice.transcribe({ clipId, ...(terminalId && { terminalId }) })),
      discard: (clipId) => call((client) => client.voice.discard({ clipId })),
    },
    murmur: {
      watch: () =>
        followRestarting(connection, (client, signal) =>
          client.murmur.watch(undefined, { signal }),
        ),
      install: () => call((client) => client.murmur.install()),
      cancel: () => call((client) => client.murmur.cancel()),
      uninstall: () => call((client) => client.murmur.uninstall()),
      set: (settings) => call((client) => client.murmur.set(settings)),
      noteOffered: () => call((client) => client.murmur.noteOffered()),
    },
    settings: {
      get: () => call((client) => client.settings.get()),
      set: (settings) => call((client) => client.settings.set(settings)),
    },
    close: () => Promise.resolve(connection.close()),
  }
}
