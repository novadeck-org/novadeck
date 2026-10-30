import type { Report } from "@novadeck/harness-core/report"
import { hookReport } from "@novadeck/harness-core/testing/reports"

import { decode } from "./decode.js"

/** A report of Antigravity's hook `event`, in conversation `c` unless `payload` names one. */
export const report = (event: string, payload: Report["payload"]): Report =>
  hookReport("agy", event, { conversationId: "c", ...payload })

/** The events Antigravity's hook `event` decodes to. */
export const hook = (event: string, payload: Report["payload"]) => decode(report(event, payload))
