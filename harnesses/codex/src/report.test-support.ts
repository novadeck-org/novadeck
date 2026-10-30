import type { Report } from "@novadeck/harness-core/report"

import { decode } from "./decode.js"

/** A report of Codex's hook `event`, in session `s` unless `payload` names one. */
export const report = (event: string, payload: Report["payload"]): Report => ({
  terminalId: "t",
  token: "0".repeat(48),
  agent: "codex",
  event,
  seq: 1,
  instance: "7",
  env: { cursor: false },
  payload: { session_id: "s", ...payload },
})

/** The events `report` decodes to. */
export const hook = (event: string, payload: Report["payload"]) => decode(report(event, payload))
