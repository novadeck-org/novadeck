import type { Report } from "@novadeck/harness-core/report"

import { decode } from "./decode.js"

/** A report of Antigravity's hook `event`, in conversation `c` unless `payload` names one. */
const report = (event: string, payload: Report["payload"]): Report => ({
  terminalId: "t",
  token: "0".repeat(48),
  agent: "agy",
  event,
  seq: 1,
  instance: "7",
  env: { cursor: false },
  payload: { conversationId: "c", ...payload },
})

/** The events Antigravity's hook `event` decodes to. */
export const hook = (event: string, payload: Report["payload"]) => decode(report(event, payload))
