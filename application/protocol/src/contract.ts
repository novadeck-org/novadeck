import { eventIterator, oc, type ContractRouterClient } from "@orpc/contract"
import { z } from "zod"

import {
  agentDetail,
  agentIntegration,
  agentRef,
  planContent,
  agentShown,
  artifactContent,
  artifactId,
  transcriptChange,
  agentName,
  clientState,
  columns,
  directory,
  id,
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
  workspaceSession,
} from "./schemas.js"

export const errors = {
  UNAUTHORIZED: { status: 401 },
  INCOMPATIBLE_PROTOCOL: { status: 409 },
  NOT_FOUND: { status: 404 },
  INVALID_DIRECTORY: { status: 400 },
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
  INVALID_CURSOR: { status: 400 },
  SPAWN_FAILED: { status: 500 },
  RUNTIME_CLOSING: { status: 503 },
  AGENT_SETUP_FAILED: { status: 500 },
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
    // that can't run one, as without NovaDeck's shell integration, is SPAWN_FAILED. A
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
    // Agents' requests for a new terminal, made through NovaDeck's MCP server, for the
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
    // Hands a terminal's title back to NovaDeck: the title the person gave it goes, and it
    // takes the one an agent gave it last, the person's first prompt there, or its
    // default, as `rename` does announcing it. TERMINAL_NOT_FOUND as for `rename`.
    resetTitle: procedure.input(z.strictObject({ terminalId: id })).output(z.void()),
    // Starts a fresh shell in an exited terminal, keeping its id, session and cwd; the
    // caller gains control. A running terminal is a CONFLICT. The earlier shell's screen
    // shows above the new one's, unless `resume` resumes an agent session, as for create.
    restart: procedure
      .input(z.strictObject({ terminalId: id, cols: columns, rows, resume: agentName.optional() }))
      .output(terminalSummary),
  },
  // Agents whose sessions resume once NovaDeck's plugin is installed into them.
  agents: {
    list: procedure.input(z.void()).output(z.array(agentIntegration)),
    // What the agent in a terminal does, in more detail than its summary: a snapshot, then
    // another on each change. It follows the terminal from agent to agent, and ends when
    // the terminal is closed. An unknown terminal is TERMINAL_NOT_FOUND.
    detail: procedure.input(z.strictObject({ terminalId: id })).output(eventIterator(agentDetail)),
    // An actor's conversation, as its harness recorded it: every item so far, then each
    // later one, while the terminal's agent runs the session the actor belongs to. An
    // actor it does not have, or one whose harness keeps no transcript NovaDeck reads, is
    // NOT_FOUND; the stream ends when the terminal's agent moves to another session.
    transcript: procedure
      .input(z.strictObject({ terminalId: id, actor: agentRef }))
      .output(eventIterator(transcriptChange)),
    // A plan `detail` lists, by its ref: its text as it stands, then again on each change,
    // while the terminal's agent keeps it as its actor's latest. A plan it does not list is
    // NOT_FOUND; the stream ends once another plan replaces it or the agent leaves.
    plan: procedure
      .input(z.strictObject({ terminalId: id, plan: agentRef }))
      .output(eventIterator(planContent)),
    // What the terminal's agents showed the user: a snapshot, then another on each
    // change, until the terminal is closed. An unknown terminal is TERMINAL_NOT_FOUND.
    shown: procedure.input(z.strictObject({ terminalId: id })).output(eventIterator(agentShown)),
    // One thing `shown` lists, as captured. One it does not list is NOT_FOUND.
    artifact: procedure
      .input(z.strictObject({ terminalId: id, artifact: artifactId }))
      .output(artifactContent),
    // Installs or removes the plugin through the agent's own commands.
    set: procedure
      .input(z.strictObject({ agent: agentName, connected: z.boolean() }))
      .output(agentIntegration),
  },
  // Messages between agents in NovaDeck's terminals (see docs/agent-messaging.md).
  messages: {
    // A terminal's threads and messages with their states. An unknown terminal is
    // TERMINAL_NOT_FOUND.
    list: procedure.input(z.strictObject({ terminalId: id })).output(terminalMessages),
    // Pauses messaging across the whole runner, every project and session, or resumes it.
    // The switch is stored, so it survives restarts; while paused, agents' messages are
    // held.
    pause: procedure.input(z.strictObject({ paused: z.boolean() })).output(z.void()),
    // Releases a thread held for going back and forth too often: its held messages are
    // delivered, and it may have 12 more. One the runner does not keep is NOT_FOUND.
    release: procedure.input(z.strictObject({ thread: threadId })).output(z.void()),
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
