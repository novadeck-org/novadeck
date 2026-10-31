import type { AgentName } from "@novadeck/protocol"

import type { Report } from "../report.js"

/**
 * A report of `agent`'s hook `event`, as the relay forwards one: from terminal `t`, by
 * process 7, started at 1, with `payload` as given (each harness names its session there
 * in its own key) and the rest of a report's fields as `overrides` set them.
 */
export const hookReport = (
  agent: AgentName,
  event: string,
  payload: Report["payload"],
  overrides: Partial<Omit<Report, "agent" | "event" | "payload">> = {},
): Report => ({
  terminalId: "t",
  token: "0".repeat(48),
  agent,
  event,
  seq: 1,
  instance: "7",
  env: { cursor: false },
  payload,
  ...overrides,
})
