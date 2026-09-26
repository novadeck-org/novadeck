import { z } from "zod"

export const protocolVersion = 1
export const id = z.uuid()
export const name = z.string().trim().min(1).max(200)
export const directory = z.string().min(1).max(4096)
export const columns = z.number().int().min(2).max(500)
export const rows = z.number().int().min(1).max(200)
export const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const project = z.strictObject({ id, name, cwd: directory })
export const workspaceSession = z.strictObject({ id, projectId: id, name })
export const terminalSummary = z.strictObject({
  id,
  sessionId: id,
  cwd: directory,
  cols: columns,
  rows,
  status: z.enum(["running", "exited"]),
  exitCode: z.number().int().nullable(),
})

const envelope = { terminalId: id, sequence }
export const terminalEvent = z.discriminatedUnion("type", [
  z.strictObject({
    ...envelope,
    type: z.literal("snapshot"),
    data: z.string(),
    cols: columns,
    rows,
    status: z.enum(["running", "exited"]),
    exitCode: z.number().int().nullable(),
  }),
  z.strictObject({ ...envelope, type: z.literal("output"), data: z.string() }),
  z.strictObject({ ...envelope, type: z.literal("resized"), cols: columns, rows }),
  z.strictObject({
    ...envelope,
    type: z.literal("exited"),
    exitCode: z.number().int().nullable(),
  }),
])

/** Wire-only marker: the attachment is established and holds the reported mode. */
export const terminalAttached = z.strictObject({
  terminalId: id,
  type: z.literal("attached"),
  mode: z.enum(["control", "observe"]),
})

export type Project = z.infer<typeof project>
export type WorkspaceSession = z.infer<typeof workspaceSession>
export type TerminalSummary = z.infer<typeof terminalSummary>
export type TerminalEvent = z.infer<typeof terminalEvent>
export type TerminalAttached = z.infer<typeof terminalAttached>
