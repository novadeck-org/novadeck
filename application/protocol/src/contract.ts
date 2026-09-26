import { eventIterator, oc, type ContractRouterClient } from "@orpc/contract"
import { z } from "zod"

import {
  columns,
  directory,
  id,
  name,
  project,
  protocolVersion,
  rows,
  sequence,
  terminalAttached,
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
          capabilities: z.array(
            z.enum(["workspace-metadata", "terminal-replay", "terminal-ack", "terminal-observers"]),
          ),
        }),
      ),
  },
  projects: {
    list: procedure.input(z.void()).output(z.array(project)),
    create: procedure.input(z.strictObject({ name, cwd: directory })).output(project),
    rename: procedure.input(z.strictObject({ projectId: id, name })).output(project),
  },
  sessions: {
    list: procedure.input(z.strictObject({ projectId: id })).output(z.array(workspaceSession)),
    create: procedure.input(z.strictObject({ projectId: id, name })).output(workspaceSession),
    rename: procedure.input(z.strictObject({ sessionId: id, name })).output(workspaceSession),
  },
  terminals: {
    list: procedure.input(z.strictObject({ sessionId: id })).output(z.array(terminalSummary)),
    create: procedure
      .input(z.strictObject({ sessionId: id, cwd: directory.optional(), cols: columns, rows }))
      .output(terminalSummary),
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
  },
}

/** The raw oRPC client. Applications use `connectRunner` from `@novadeck/protocol/client`. */
export type WireClient = ContractRouterClient<typeof contract>
export type ErrorCode = keyof typeof errors
