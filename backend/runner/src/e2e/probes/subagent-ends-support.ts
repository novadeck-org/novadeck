// Probe support for the subagent-ends probes: every hook report the runner hears, whichever
// harness sent it, recorded raw as the runner queues it.
import type { Report } from "@novadeck/harness-core/report"

import { Reports } from "../../terminals/binding/reports.js"

export type Heard = {
  readonly at: number
  readonly agent: string
  readonly event: string
  readonly seq: number
  readonly payload: Report["payload"]
}

/** Records every report from now on, until `stop`. */
export const listen = () => {
  const heard: Heard[] = []
  const prototype = Reports.prototype
  const { queueReport, queueAsk } = prototype
  const note = (report: Report) =>
    heard.push({
      at: Date.now(),
      agent: report.agent,
      event: report.event,
      seq: report.seq,
      payload: report.payload,
    })
  prototype.queueReport = function (this: Reports, report: Report) {
    note(report)
    return queueReport.call(this, report)
  }
  prototype.queueAsk = function (this: Reports, report: Report, deadline: number) {
    note(report)
    return queueAsk.call(this, report, deadline)
  }
  return {
    heard,
    stop: () => {
      prototype.queueReport = queueReport
      prototype.queueAsk = queueAsk
    },
  }
}
