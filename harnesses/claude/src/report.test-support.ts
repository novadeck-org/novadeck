import type { Report } from "@novadeck/harness-core/report"
import { hookReport } from "@novadeck/harness-core/testing/reports"

import { decode } from "./decode.js"

/** A report of Claude Code's hook `event`, in session `s` unless `payload` names one. */
export const report = (event: string, payload: Report["payload"]): Report =>
  hookReport("claude", event, { session_id: "s", ...payload })

/** The events `report` decodes to. */
export const hook = (event: string, payload: Report["payload"]) => decode(report(event, payload))
