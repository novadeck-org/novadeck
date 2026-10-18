import { createKeyedStore, type KeyedStore, type Store } from "./store"
import type { AgentUsage } from "./types"

// What the agents in every session say of their tokens and quotas, apart from their
// terminals: a status line reports often, and a terminal's metadata would change with
// each report. Kept by the session that holds the terminal
// (`${projectId}/${workspaceSessionId}`), then by terminal id; a terminal without an entry
// has reported nothing.
export type Telemetry = Readonly<Record<string, Readonly<Record<string, AgentUsage>>>>

export const noTelemetry: Telemetry = {}

// One terminal's place in the telemetry.
export type TelemetryKey = { readonly context: string; readonly terminalId: string }

// The telemetry as a backend keeps it: the whole of it, and each terminal's usage alone,
// whose readers wake only when that terminal reports something new.
export type TelemetryStore = KeyedStore<Telemetry, TelemetryKey, AgentUsage | undefined>

// What readers get of it: they read and subscribe, the backend alone changes it.
export type TelemetryReader = Store<Telemetry> & Pick<TelemetryStore, "entry">

export const createTelemetryStore = (initial: Telemetry = noTelemetry): TelemetryStore =>
  createKeyedStore(
    initial,
    (telemetry, { context, terminalId }: TelemetryKey) => telemetry[context]?.[terminalId],
    ({ context, terminalId }) => `${context}\n${terminalId}`,
  )

const sameUsage = (a: AgentUsage, b: AgentUsage): boolean => JSON.stringify(a) === JSON.stringify(b)

// The terminal's usage as the agent last reported it, replacing the one before. Only its
// terminal's entry and its session's record change; a report equal to the held one changes
// nothing at all.
export const setUsage = (
  telemetry: Telemetry,
  context: string,
  terminalId: string,
  usage: AgentUsage,
): Telemetry => {
  const held = telemetry[context]?.[terminalId]
  if (held && sameUsage(held, usage)) return telemetry
  return { ...telemetry, [context]: { ...telemetry[context], [terminalId]: usage } }
}

// Without the terminal's usage, and without its session's record once that holds none.
export const dropTerminal = (
  telemetry: Telemetry,
  context: string,
  terminalId: string,
): Telemetry => {
  const record = telemetry[context]
  if (!record || !(terminalId in record)) return telemetry
  const { [terminalId]: _gone, ...rest } = record
  return Object.keys(rest).length > 0
    ? { ...telemetry, [context]: rest }
    : dropContext(telemetry, context)
}

// Without the records of all of a project's sessions, as when the project is gone.
export const dropProject = (telemetry: Telemetry, projectId: string): Telemetry => {
  const gone = Object.keys(telemetry).filter((context) => context.startsWith(`${projectId}/`))
  return gone.reduce(dropContext, telemetry)
}

// Without a session's record, as when its last terminal's or its project's usage goes.
export const dropContext = (telemetry: Telemetry, context: string): Telemetry => {
  if (!(context in telemetry)) return telemetry
  const { [context]: _gone, ...rest } = telemetry
  return rest
}
