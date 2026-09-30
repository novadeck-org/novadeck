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
  terminalAttached,
  terminalChange,
  terminalEvent,
  terminalSummary,
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
    list: procedure.input(z.strictObject({ sessionId: id })).output(z.array(terminalSummary)),
    // `restore` starts where the runner's saved record of this terminal left off: in its
    // last directory, showing its saved transcript before the shell's output. `resume`
    // names the agent that ran there: while it is connected, the runner resumes the
    // session it last reported in this terminal, instead of showing the transcript.
    // A session resumes in one terminal only, never beside another terminal running it.
    create: procedure
      .input(
        z.strictObject({
          id,
          sessionId: id,
          cwd: directory.optional(),
          cols: columns,
          rows,
          restore: z.boolean().optional(),
          resume: agentName.optional(),
        }),
      )
      .output(terminalSummary),
    // Every terminal across sessions: `changed` for each, `synced`, then later changes
    // (creation, size, foreground process, exit, restart) and `removed` when a record
    // is closed or evicted.
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
  settings: {
    get: procedure.input(z.void()).output(runnerSettings),
    // Changes the settings given; the others stay.
    set: procedure.input(runnerSettings.partial()).output(z.void()),
  },
}

/** The raw oRPC client. Applications use `connectRunner` from `@novadeck/protocol/client`. */
export type WireClient = ContractRouterClient<typeof contract>
export type ErrorCode = keyof typeof errors
