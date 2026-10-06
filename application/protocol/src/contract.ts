import { eventIterator, oc, type ContractRouterClient } from "@orpc/contract"
import { z } from "zod"

import {
  agentDetail,
  agentIntegration,
  agentRef,
  transcriptChange,
  agentName,
  clientState,
  columns,
  companionChange,
  companionItem,
  companionWindow,
  directory,
  id,
  itemContent,
  maxUploadPartLength,
  maxVoicePartLength,
  name,
  project,
  protocolVersion,
  rows,
  runnerSettings,
  sequence,
  startupCommand,
  terminalAttached,
  terminalChange,
  terminalEvent,
  terminalRequest,
  terminalRequestAnswer,
  terminalMessages,
  terminalSummary,
  terminalTitle,
  threadId,
  voiceModel,
  voiceSettings,
  voiceState,
  voiceTranscript,
  workspaceSession,
} from "./schemas.js"

export const errors = {
  UNAUTHORIZED: { status: 401 },
  INCOMPATIBLE_PROTOCOL: { status: 409 },
  NOT_FOUND: { status: 404 },
  INVALID_DIRECTORY: { status: 400 },
  INVALID_FILE: { status: 400 },
  CONFLICT: { status: 409 },
  RESOURCE_LIMIT: { status: 429 },
  TERMINAL_LIMIT: { status: 429 },
  TERMINAL_NOT_FOUND: { status: 404 },
  TERMINAL_EXITED: { status: 409 },
  CONTROL_IN_USE: { status: 409 },
  CONTROL_REQUIRED: { status: 403 },
  ALREADY_ATTACHED: { status: 409 },
  SLOW_CONSUMER: { status: 429 },
  SNAPSHOT_TOO_LARGE: { status: 413 },
  UPLOAD_TOO_LARGE: { status: 413 },
  INVALID_CURSOR: { status: 400 },
  SPAWN_FAILED: { status: 500 },
  RUNTIME_CLOSING: { status: 503 },
  AGENT_SETUP_FAILED: { status: 500 },
  VOICE_UNAVAILABLE: { status: 409 },
  VOICE_FAILED: { status: 500 },
}

const procedure = oc.errors(errors)

export const contract = {
  runner: {
    // Trusted transports, such as a host-provided MessagePort, need no token.
    handshake: procedure
      .input(
        z.strictObject({
          protocolVersion: z.number().int(),
          token: z.string().min(1).max(512).optional(),
          // Stable per client across reconnections. A new connection with the same
          // client ID takes over from the old one, even if that one is still half-open.
          clientId: id.optional(),
        }),
      )
      .output(
        z.strictObject({
          runnerId: id,
          protocolVersion: z.literal(protocolVersion),
        }),
      ),
  },
  projects: {
    list: procedure.input(z.void()).output(z.array(project)),
    // The client names the project before the runner answers; a taken id is a
    // CONFLICT. Without `cwd`, the project opens in the runner owner's home directory.
    create: procedure
      .input(z.strictObject({ id, name, cwd: directory.optional() }))
      .output(project),
    rename: procedure.input(z.strictObject({ projectId: id, name })).output(project),
    // Closes every terminal of the project's sessions, as `terminals.close` does but
    // whichever connection controls them, then forgets the project, its sessions and its
    // agents' messages; its folder stays. A project the runner doesn't have, as one
    // removed already, is NOT_FOUND.
    remove: procedure.input(z.strictObject({ projectId: id })).output(z.void()),
  },
  sessions: {
    list: procedure.input(z.strictObject({ projectId: id })).output(z.array(workspaceSession)),
    create: procedure.input(z.strictObject({ id, projectId: id, name })).output(workspaceSession),
    rename: procedure.input(z.strictObject({ sessionId: id, name })).output(workspaceSession),
    // Replaces the session's client state; the runner stores it without reading it.
    save: procedure.input(z.strictObject({ sessionId: id, state: clientState })).output(z.void()),
  },
  terminals: {
    // Every terminal of the session, running or saved to restore, oldest first.
    list: procedure.input(z.strictObject({ sessionId: id })).output(z.array(terminalSummary)),
    // `restore` starts where the runner's saved record of this terminal left off: in its
    // last directory, showing its saved transcript before the shell's output. `resume`
    // names the agent that ran there: while it is connected, the runner resumes the
    // session it last reported in this terminal, instead of showing the transcript.
    // A session resumes in one terminal only, never beside another terminal running it.
    // `command` runs once at the new shell's first prompt, as if typed there; a shell
    // that can't run one, as without Novadeck's shell integration, is SPAWN_FAILED. A
    // command goes with neither `restore` nor `resume`.
    create: procedure
      .input(
        z
          .strictObject({
            id,
            sessionId: id,
            cwd: directory.optional(),
            cols: columns,
            rows,
            restore: z.boolean().optional(),
            resume: agentName.optional(),
            command: startupCommand.optional(),
            // Its title, the person's; a restored terminal keeps its saved one, and a new
            // one takes the session's next default, when left out.
            title: terminalTitle.optional(),
            // The agent's request this terminal answers (`requests`): it takes the title
            // that agent asked for, as the agent's.
            requestId: id.optional(),
          })
          .refine(({ command, restore, resume }) => !command || (!restore && !resume), {
            message: "A terminal either starts a command or restores what it ran, not both.",
          }),
      )
      .output(terminalSummary),
    // Agents' requests for a new terminal, made through Novadeck's MCP server, for the
    // client to open where it lays terminals out. The runner sends each to the client
    // that subscribed last and waits a few seconds for its `answerRequest`.
    requests: procedure.input(z.void()).output(eventIterator(terminalRequest)),
    // Answers a request with the terminal the client opened for it, or why it didn't.
    // One the runner no longer waits for, or sent to another client, is NOT_FOUND.
    answerRequest: procedure.input(terminalRequestAnswer).output(z.void()),
    // Every terminal across sessions, running or saved: `changed` for each, `synced`, then
    // later changes (creation, title, size, foreground process, exit, restart, and its
    // shell's record let go, when it is saved again) and `removed` once it is closed.
    watch: procedure.input(z.void()).output(eventIterator(terminalChange)),
    attach: procedure
      .input(
        z.strictObject({
          terminalId: id,
          afterSequence: sequence.optional(),
          mode: z.enum(["control", "observe"]).optional(),
        }),
      )
      .output(eventIterator(z.union([terminalAttached, terminalEvent]))),
    write: procedure
      .input(z.strictObject({ terminalId: id, data: z.string().min(1).max(16_384) }))
      .output(z.void()),
    resize: procedure
      .input(z.strictObject({ terminalId: id, cols: columns, rows }))
      .output(z.void()),
    ack: procedure.input(z.strictObject({ terminalId: id, sequence })).output(z.void()),
    close: procedure.input(z.strictObject({ terminalId: id })).output(z.void()),
    // Renames a terminal: the runner keeps the title with the terminal, running or saved
    // to restore, and announces it on `watch`. One it keeps nothing of is
    // TERMINAL_NOT_FOUND; a new terminal takes its first title with `create`, or the
    // session's next default.
    rename: procedure
      .input(z.strictObject({ terminalId: id, title: terminalTitle }))
      .output(z.void()),
    // Hands a terminal's title back to Novadeck: the title the person gave it goes, and it
    // takes the one an agent gave it last, the person's first prompt there, or its
    // default, as `rename` does announcing it. TERMINAL_NOT_FOUND as for `rename`.
    resetTitle: procedure.input(z.strictObject({ terminalId: id })).output(z.void()),
    // Saves a file pasted into a terminal in a folder of its own on the runner's machine,
    // for the terminal's programs to read at the absolute `path` it answers; uploads go a
    // week later. The file comes base64 in parts: one with `name`
    // starts it, and one with the `path` an earlier part answered adds to it. A file past
    // `maxUploadBytes` is UPLOAD_TOO_LARGE and goes, a `path` the runner isn't receiving
    // is NOT_FOUND, and a terminal it keeps nothing of TERMINAL_NOT_FOUND.
    upload: procedure
      .input(
        z
          .strictObject({
            terminalId: id,
            name: z.string().min(1).max(255).optional(),
            path: directory.optional(),
            data: z.base64().max(maxUploadPartLength),
          })
          .refine((part) => (part.name === undefined) !== (part.path === undefined), {
            message: "A part either starts a file by its name or adds to one by its path.",
          }),
      )
      .output(z.strictObject({ path: directory })),
    // Starts a fresh shell in an exited terminal, keeping its id, session and cwd; the
    // caller gains control. A running terminal is a CONFLICT. The earlier shell's screen
    // shows above the new one's, unless `resume` resumes an agent session, as for create.
    restart: procedure
      .input(z.strictObject({ terminalId: id, cols: columns, rows, resume: agentName.optional() }))
      .output(terminalSummary),
  },
  // Agents whose sessions resume once Novadeck's plugin is installed into them.
  agents: {
    list: procedure.input(z.void()).output(z.array(agentIntegration)),
    // What the agent in a terminal does, in more detail than its summary: a snapshot, then
    // another on each change. It follows the terminal from agent to agent, and ends when
    // the terminal is closed. An unknown terminal is TERMINAL_NOT_FOUND.
    detail: procedure.input(z.strictObject({ terminalId: id })).output(eventIterator(agentDetail)),
    // An actor's conversation, as its harness recorded it: every item so far, then each
    // later one, while the terminal's agent runs the session the actor belongs to. An
    // actor it does not have, or one whose harness keeps no transcript Novadeck reads, is
    // NOT_FOUND; the stream ends when the terminal's agent moves to another session.
    transcript: procedure
      .input(z.strictObject({ terminalId: id, actor: agentRef }))
      .output(eventIterator(transcriptChange)),
    // Installs or removes the plugin through the agent's own commands.
    set: procedure
      .input(z.strictObject({ agent: agentName, connected: z.boolean() }))
      .output(agentIntegration),
  },
  // What agents show and the person attaches beside terminals: items held by a terminal's
  // bar or an undocked window, kept across restarts as pointers to files, pages and plans.
  companions: {
    // A session's items and windows. An unknown session is NOT_FOUND.
    list: procedure
      .input(z.strictObject({ sessionId: id }))
      .output(z.strictObject({ items: z.array(companionItem), windows: z.array(companionWindow) })),
    // Every item and window across sessions: each, `synced`, then later changes, as
    // `terminals.watch` reports terminals. What comes before `synced` is a set, applied
    // whole at `synced`. After it, each change is the latest state of its item or window,
    // in the order they first changed since the reader last caught up, so a reference
    // (an item's holder window, a window's item, an item's terminal) may name one not yet
    // reported, or one whose removal follows. They agree once the stream is idle.
    watch: procedure.input(z.void()).output(eventIterator(companionChange)),
    // What an item points at, read now, then again each time it changes, until it is
    // deleted. A file that may hold secrets is `held` unless `reveal`. An unknown item is
    // NOT_FOUND.
    content: procedure
      .input(z.strictObject({ itemId: id, reveal: z.boolean().optional() }))
      .output(eventIterator(itemContent)),
    // Attaches a file the person picked to a terminal's bar, by a path absolute or from
    // the terminal's directory. A terminal the runner keeps nothing of is
    // TERMINAL_NOT_FOUND; a path that is no file is INVALID_FILE, saying why.
    attach: procedure
      .input(
        z.strictObject({
          terminalId: id,
          path: z.string().min(1).max(4096),
          lines: z
            .strictObject({ from: z.int().min(1), to: z.int().min(1) })
            .refine(({ from, to }) => to >= from)
            .optional(),
          title: z.string().min(1).max(256).optional(),
        }),
      )
      .output(companionItem),
    // Moves an item onto a terminal's bar, from a bar or a window, which goes with it; what
    // that bar held under the same pointer is replaced. An unknown item is NOT_FOUND, an
    // unknown terminal TERMINAL_NOT_FOUND, and one of another session a CONFLICT.
    move: procedure.input(z.strictObject({ itemId: id, terminalId: id })).output(companionItem),
    // Moves an item into a new window the client names; a taken id is a CONFLICT.
    undock: procedure.input(z.strictObject({ itemId: id, windowId: id })).output(companionWindow),
    // Deletes an item and the window holding it; closing a window is this call.
    close: procedure.input(z.strictObject({ itemId: id })).output(z.void()),
    // Gives a window the person's title. An unknown window is NOT_FOUND.
    renameWindow: procedure
      .input(z.strictObject({ windowId: id, title: terminalTitle }))
      .output(z.void()),
    // Gives a window its item's name again, as `renameWindow` does.
    resetWindowTitle: procedure.input(z.strictObject({ windowId: id })).output(z.void()),
  },
  // Messages between agents in Novadeck's terminals (see docs/agent-messaging.md).
  messages: {
    // A terminal's threads and messages with their states. An unknown terminal is
    // TERMINAL_NOT_FOUND.
    list: procedure.input(z.strictObject({ terminalId: id })).output(terminalMessages),
    // What `list` says, then again on each change to the terminal's threads, messages or
    // delivery state, or to the pause, until the terminal is gone. An unknown terminal is
    // TERMINAL_NOT_FOUND.
    watch: procedure
      .input(z.strictObject({ terminalId: id }))
      .output(eventIterator(terminalMessages)),
    // Pauses messaging across the whole runner, every project and session, or resumes it.
    // The switch is stored, so it survives restarts; while paused, agents' messages are
    // held.
    pause: procedure.input(z.strictObject({ paused: z.boolean() })).output(z.void()),
    // Releases a thread held for going back and forth too often: its held messages are
    // delivered, and it may have 12 more. One the runner does not keep is NOT_FOUND.
    release: procedure.input(z.strictObject({ thread: threadId })).output(z.void()),
  },
  // Voice input, transcribed on this machine (see `voiceState`).
  voice: {
    // The addon's state, then again on each change.
    watch: procedure.input(z.void()).output(eventIterator(voiceState)),
    // Downloads the engine, unless it is there, and a model, checks that they transcribe,
    // and makes the model the one used. It returns once the install starts; `watch` shows
    // its progress, and its end or failure. One already installing is a CONFLICT, and a
    // build without an engine for this platform is VOICE_UNAVAILABLE.
    install: procedure.input(z.strictObject({ model: voiceModel })).output(z.void()),
    // Stops an install, keeping what had finished before it. Nothing installing is fine.
    cancel: procedure.input(z.void()).output(z.void()),
    // Removes the engine and every model, and turns voice input off.
    uninstall: procedure.input(z.void()).output(z.void()),
    // Changes the settings given; the others stay. Turning voice input on, or choosing a
    // model, that is not installed is a CONFLICT.
    set: procedure.input(voiceSettings.partial()).output(z.void()),
    // Adds audio to a clip being recorded, which the client names: 16 kHz mono 16-bit
    // little-endian PCM, base64, at the byte `offset` into the clip. Audio past
    // `maxVoiceSeconds` is UPLOAD_TOO_LARGE, and a part past the start of a clip the
    // runner does not have NOT_FOUND. Voice input that is off is VOICE_UNAVAILABLE.
    // Clips nobody transcribes are forgotten after a few minutes.
    record: procedure
      .input(
        z.strictObject({
          clipId: id,
          offset: z.int().nonnegative(),
          data: z.base64().max(maxVoicePartLength),
        }),
      )
      .output(z.void()),
    // Transcribes a recorded clip and forgets it. `prompt` names words likely said, such
    // as file names, to spell them right. An unknown clip is NOT_FOUND, voice input that
    // is off VOICE_UNAVAILABLE, and an engine that fails VOICE_FAILED, saying why.
    transcribe: procedure
      .input(z.strictObject({ clipId: id, prompt: z.string().max(1024).optional() }))
      .output(voiceTranscript),
    // Forgets a clip without transcribing it. An unknown clip is fine.
    discard: procedure.input(z.strictObject({ clipId: id })).output(z.void()),
  },
  settings: {
    get: procedure.input(z.void()).output(runnerSettings),
    // Changes the settings given; the others stay.
    set: procedure.input(runnerSettings.partial()).output(z.void()),
  },
}

/** The raw oRPC client. Applications use `connectRunner` from `@novadeck/protocol/client`. */
export type WireClient = ContractRouterClient<typeof contract>
export type ErrorCode = keyof typeof errors
